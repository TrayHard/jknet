import { AtSign, MessageCircle, Volume2, VolumeX } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { CHAT_SOUNDS, chatNotificationsOf, isChatSound } from "../../../lib/chat/notifySettings";
import type { ChatNotificationsPatch, ChatSoundName } from "../../../lib/ipc";
import { usePreviewChatSound, useSettings } from "../../../lib/queries";
import { Button, Select } from "../../ui";
import { SettingRow, SettingsCard, ToggleRow } from "./SettingRow";

interface ChatSoundsCardProps {
  onChange: (patch: ChatNotificationsPatch) => void;
}

/**
 * --- slice: chat notifications ---
 *
 * Settings · Chat · Sounds: whether a message that notifies plays a sound,
 * which of the three sets the core ships (`src-tauri/resources/sounds/`), and
 * a preview of both of its tones. Mentions and replies play the mention tone
 * of the set, so there is no separate switch for them. The core plays the
 * file through Windows, which has no volume of its own: the volume is the
 * one of the system mixer.
 */
export function ChatSoundsCard({ onChange }: ChatSoundsCardProps) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const settings = useSettings();
  const notifications = chatNotificationsOf(settings.data);
  const loading = settings.data === undefined;
  const preview = usePreviewChatSound();
  const [error, setError] = useState<string | null>(null);

  const soundName: ChatSoundName = isChatSound(notifications.soundName) ? notifications.soundName : "default";
  const soundLabel = t(`settings.sounds.names.${soundName}`);
  const off = loading || !notifications.sound;

  const play = (mention: boolean) => {
    setError(null);
    preview.mutate(
      { soundName, mention },
      { onError: (e) => setError(t("settings.sounds.previewFailed", { error: errorText(e) })) },
    );
  };

  return (
    <SettingsCard
      icon={notifications.sound ? <Volume2 size={20} /> : <VolumeX size={20} />}
      title={t("settings.sounds.title")}
      text={t("settings.sounds.text")}
    >
      <ToggleRow
        title={t("settings.sounds.sound")}
        hint={t("settings.sounds.soundHint")}
        checked={notifications.sound}
        disabled={loading}
        onChange={(sound) => onChange({ sound })}
      />
      <SettingRow
        title={t("settings.sounds.pick")}
        hint={t("settings.sounds.pickHint")}
        disabled={off}
        control={
          <Select
            size="sm"
            ariaLabel={t("settings.sounds.pick")}
            value={soundName}
            disabled={off}
            options={CHAT_SOUNDS.map((name) => ({ value: name, label: t(`settings.sounds.names.${name}`) }))}
            onChange={(value) => {
              if (isChatSound(value) && value !== soundName) onChange({ soundName: value });
            }}
            className="w-176"
          />
        }
      />
      <SettingRow
        title={t("settings.sounds.preview")}
        hint={t("settings.sounds.previewHint")}
        disabled={off}
        control={
          <>
            <Button
              size="sm"
              variant="secondary"
              icon={<MessageCircle size={14} />}
              aria-label={t("settings.sounds.previewMessageLabel", { name: soundLabel })}
              disabled={off || preview.isPending}
              onClick={() => play(false)}
            >
              {t("settings.sounds.previewMessage")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<AtSign size={14} />}
              aria-label={t("settings.sounds.previewMentionLabel", { name: soundLabel })}
              disabled={off || preview.isPending}
              onClick={() => play(true)}
            >
              {t("settings.sounds.previewMention")}
            </Button>
          </>
        }
      >
        {error === null ? null : (
          <p role="alert" className="text-body-sm text-fg-danger">
            {error}
          </p>
        )}
      </SettingRow>
    </SettingsCard>
  );
}
