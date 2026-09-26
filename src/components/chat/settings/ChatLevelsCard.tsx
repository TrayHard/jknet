import { AtSign, BellOff, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { useLocale } from "../../../i18n/useFormat";
import { mutedChats } from "../../../lib/chat/notifySettings";
import type { ChatNotifyLevel, Conversation } from "../../../lib/ipc";
import { useChatState, useSetChatNotify } from "../../../lib/queries";
import { Button, Select } from "../../ui";
import { ConversationAvatar } from "../ConversationAvatar";
import { useOpenChat } from "../useOpenChat";
import { useChatNames } from "../useChatText";
import { SettingsCard } from "./SettingRow";

const LEVELS: ChatNotifyLevel[] = ["all", "mentions", "mute"];

/**
 * --- slice: chat notifications ---
 *
 * Settings · Chat · Chats with their own notifications: every chat whose
 * level is not **All messages**, muted ones first, with its level to change
 * and **Reset all** to put every one of them back.
 *
 * The level itself lives on the service, one per chat and account
 * (`chat_set_notify`), and is set where the chat is — the menu of its
 * header, the group info. This card is where the player finds the chats
 * they silenced a month ago. A muted chat still notifies about mentions and
 * replies (D7), which its row says.
 *
 * Drawn only while there is a chat state to read: signed out, the Privacy
 * card says what to do.
 */
export function ChatLevelsCard() {
  const { t } = useTranslation("chat");
  const locale = useLocale();
  const errorText = useErrorText();
  const state = useChatState().data;
  const names = useChatNames();
  const openChat = useOpenChat();
  const setNotify = useSetChatNotify();
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const rows = useMemo(
    () => mutedChats(state?.conversations ?? [], names.title, locale),
    [state?.conversations, names, locale],
  );

  if (state === undefined || !state.signedIn || !state.available) return null;

  const change = (conversation: Conversation, notify: ChatNotifyLevel) => {
    setError(null);
    setNotify.mutate(
      { conversationId: conversation.id, notify },
      { onError: (e) => setError(t("settings.failed", { error: errorText(e) })) },
    );
  };

  const resetAll = async () => {
    setError(null);
    setResetting(true);
    try {
      for (const conversation of rows) {
        await setNotify.mutateAsync({ conversationId: conversation.id, notify: "all" });
      }
    } catch (e) {
      setError(t("settings.failed", { error: errorText(e) }));
    } finally {
      setResetting(false);
    }
  };

  const options = LEVELS.map((level) => ({ value: level, label: t(`notify.${level}`) }));

  return (
    <SettingsCard
      icon={<BellOff size={20} />}
      title={t("settings.levels.title")}
      text={t("settings.levels.text")}
      action={
        <Button
          size="sm"
          variant="ghost"
          icon={<RotateCcw size={14} />}
          disabled={rows.length === 0 || resetting}
          onClick={() => void resetAll()}
        >
          {t("settings.levels.resetAll")}
        </Button>
      }
    >
      {rows.length === 0 ? (
        <p className="text-body-sm text-fg-muted">{t("settings.levels.empty")}</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((conversation) => {
            const title = names.title(conversation);
            return (
              <li
                key={conversation.id}
                className="flex items-center gap-12 py-8 border-t border-line-subtle first:border-t-0 first:pt-0"
              >
                <ConversationAvatar conversation={conversation} meId={names.meId} size="sm" />
                <span className="flex-1 min-w-0 flex flex-col">
                  <button
                    type="button"
                    className="text-left text-body-md-medium text-fg truncate hover:underline cursor-pointer"
                    title={t("settings.levels.open", { title })}
                    onClick={() => openChat(conversation.id)}
                  >
                    {title}
                  </button>
                  <span className="flex items-start gap-4 text-body-sm text-fg-muted">
                    {conversation.notify === "mute" ? (
                      <BellOff size={12} className="shrink-0 mt-4" />
                    ) : (
                      <AtSign size={12} className="shrink-0 mt-4" />
                    )}
                    <span>
                      {conversation.notify === "mute"
                        ? t("settings.levels.muteNote")
                        : t("settings.levels.mentionsNote")}
                    </span>
                  </span>
                </span>
                <Select
                  size="sm"
                  ariaLabel={t("settings.levels.levelOf", { title })}
                  value={conversation.notify}
                  options={options}
                  disabled={resetting}
                  onChange={(value) => {
                    if (value !== conversation.notify) change(conversation, value as ChatNotifyLevel);
                  }}
                  className="w-192 shrink-0"
                />
              </li>
            );
          })}
        </ul>
      )}
      {error === null ? null : (
        <p role="alert" className="text-body-sm text-fg-danger pt-8">
          {error}
        </p>
      )}
    </SettingsCard>
  );
}
