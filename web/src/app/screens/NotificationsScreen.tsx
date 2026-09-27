import { AlertTriangle } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChatSoundsCard } from "../../../../src/components/chat/settings/ChatSoundsCard.tsx";
import { useErrorText } from "../../../../src/i18n/errors.ts";
import type { ChatNotificationsPatch } from "../../../../src/lib/ipc.ts";
import { useUpdateChatSettings } from "../../../../src/lib/queries.ts";

/**
 * Settings · Notifications: the chat sound of this browser — on or off, the
 * set, a preview of its two tones — through the launcher's sounds card. The
 * sound plays whenever the app is open, a tab in the background included;
 * the switch is this device's own and never touches the launcher's.
 */
export function NotificationsScreen() {
  const { t } = useTranslation("web");
  const { t: tChat } = useTranslation("chat");
  const errorText = useErrorText();
  const update = useUpdateChatSettings();
  const { mutate } = update;
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(
    (chatNotifications: ChatNotificationsPatch) => {
      setError(null);
      mutate({ chatNotifications }, { onError: (e) => setError(tChat("settings.failed", { error: errorText(e) })) });
    },
    [mutate, tChat, errorText],
  );

  return (
    <div className="flex flex-col gap-16 px-16 py-24 sm:px-40 sm:py-32" data-testid="notifications-screen">
      {error === null ? null : (
        <div role="alert" className="flex items-start gap-8 rounded-md border border-line-danger bg-danger-subtle p-12">
          <AlertTriangle size={16} className="mt-2 shrink-0 text-fg-danger" />
          <span className="text-body-sm text-fg">{error}</span>
        </div>
      )}
      <ChatSoundsCard onChange={save} text={t("notifications.soundText")} />
    </div>
  );
}
