import { AlertTriangle } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import type { ChatNotificationsPatch, SettingsPatch } from "../../../lib/ipc";
import { useUpdateChatSettings } from "../../../lib/queries";
import { ChatFilesCard } from "./ChatFilesCard";
import { ChatLevelsCard } from "./ChatLevelsCard";
import { ChatNotificationsCard } from "./ChatNotificationsCard";
import { ChatPrivacyCard } from "./ChatPrivacyCard";
import { ChatSoundsCard } from "./ChatSoundsCard";
import { TrayStartupCard } from "./TrayStartupCard";

/** The anchor of the group: `#/settings?section=chat`. */
export const CHAT_SETTINGS_SECTION_ID = "settings-chat";

/**
 * --- slice: chat notifications ---
 *
 * Settings · Chat: the group of cards after the Account card, laid out as
 * the H-Settings board of the prototype draws it — notifications, sounds
 * and the chats with their own level in the left column; the tray, privacy
 * and files in the right one. One column when the page is narrow (the chat
 * drawer pinned at the smallest window).
 *
 * Every switch applies at once. The settings of the launcher go out as a
 * patch of the one field that moved (`useUpdateChatSettings`, optimistic);
 * privacy and the level of a chat go to the service through their own
 * commands. A refusal of a patch is said once, at the top of the group.
 */
export function ChatSettings() {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const update = useUpdateChatSettings();
  const [error, setError] = useState<string | null>(null);
  const { mutate } = update;

  const save = useCallback(
    (patch: SettingsPatch) => {
      setError(null);
      mutate(patch, { onError: (e) => setError(t("settings.failed", { error: errorText(e) })) });
    },
    [mutate, t, errorText],
  );
  const saveNotifications = useCallback(
    (chatNotifications: ChatNotificationsPatch) => save({ chatNotifications }),
    [save],
  );

  return (
    <section
      id={CHAT_SETTINGS_SECTION_ID}
      aria-labelledby={`${CHAT_SETTINGS_SECTION_ID}-title`}
      className="mb-24 scroll-mt-24"
    >
      <div className="pb-12">
        <h2 id={`${CHAT_SETTINGS_SECTION_ID}-title`} className="text-heading-md text-fg pb-4">
          {t("settings.title")}
        </h2>
        <p className="text-body-sm text-fg-secondary">{t("settings.text")}</p>
      </div>

      {error === null ? null : (
        <div
          role="alert"
          className="flex items-start gap-8 rounded-md border border-line-danger bg-danger-subtle p-12 mb-16"
        >
          <AlertTriangle size={16} className="text-fg-danger shrink-0 mt-2" />
          <span className="text-body-sm text-fg">{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-16 items-start @min-[880px]/page:grid-cols-2">
        <div className="flex flex-col gap-16 min-w-0">
          <ChatNotificationsCard onChange={saveNotifications} />
          <ChatSoundsCard onChange={saveNotifications} />
          <ChatLevelsCard />
        </div>
        <div className="flex flex-col gap-16 min-w-0">
          <TrayStartupCard onChange={save} />
          <ChatPrivacyCard />
          <ChatFilesCard onChange={save} />
        </div>
      </div>
    </section>
  );
}
