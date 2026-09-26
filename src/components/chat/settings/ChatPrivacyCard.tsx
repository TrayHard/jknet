import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import type { ChatPrivacy } from "../../../lib/ipc";
import { useChatState, useOnlineConfigured, useUpdateChatPrivacy } from "../../../lib/queries";
import { ChoiceRow, SettingsCard, ToggleRow } from "./SettingRow";

/**
 * --- slice: chat notifications ---
 *
 * Settings · Chat · Privacy: the two switches of D8 and who may add the
 * player to a group.
 *
 * All three live on JKNet Online (`chat_update_privacy`), so they follow the
 * account to every computer. Both switches work both ways, and the service
 * enforces it: a player who hides their read receipts sees nobody's, a
 * player who hides their typing sees nobody typing. The helper line of each
 * says so, since that is the part nobody expects. The thread stops drawing
 * read marks and typing lines the moment a switch goes off
 * (`useChatPrivacy`), without waiting for the service.
 *
 * Signed out, or with a service that has no chats, the switches are there
 * but off-limits, with the reason on top.
 */
export function ChatPrivacyCard() {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const configured = useOnlineConfigured();
  const state = useChatState().data;
  const update = useUpdateChatPrivacy();
  const [error, setError] = useState<string | null>(null);

  const privacy = state?.privacy ?? null;
  const ready = configured !== false && state !== undefined && state.signedIn && state.available && privacy !== null;
  const reason =
    configured === false
      ? t("settings.privacy.notConfigured")
      : state !== undefined && !state.signedIn
        ? t("settings.privacy.signedOut")
        : state !== undefined && !state.available
          ? t("settings.privacy.unavailable")
          : null;

  const change = (patch: Partial<ChatPrivacy>) => {
    setError(null);
    update.mutate(patch, { onError: (e) => setError(t("settings.failed", { error: errorText(e) })) });
  };

  return (
    <SettingsCard
      icon={<ShieldCheck size={20} />}
      title={t("settings.privacy.title")}
      text={t("settings.privacy.text")}
    >
      {reason === null ? null : (
        <p role="status" className="rounded-md border border-line bg-input px-12 py-8 mb-12 text-body-sm text-fg-secondary">
          {reason}
        </p>
      )}
      <ToggleRow
        title={t("settings.privacy.readReceipts")}
        hint={t("settings.privacy.readReceiptsHint")}
        checked={privacy?.shareReadReceipts ?? true}
        disabled={!ready}
        onChange={(shareReadReceipts) => change({ shareReadReceipts })}
      />
      <ToggleRow
        title={t("settings.privacy.typing")}
        hint={t("settings.privacy.typingHint")}
        checked={privacy?.shareTyping ?? true}
        disabled={!ready}
        onChange={(shareTyping) => change({ shareTyping })}
      />
      <ChoiceRow<ChatPrivacy["groupAdd"]>
        title={t("settings.privacy.groupAdd")}
        hint={t("settings.privacy.groupAddHint")}
        value={privacy?.groupAdd ?? "friends"}
        disabled={!ready}
        options={[
          { value: "friends", label: t("settings.privacy.groupAddFriends") },
          { value: "ask", label: t("settings.privacy.groupAddAsk") },
        ]}
        onChange={(groupAdd) => change({ groupAdd })}
      />
      {error === null ? null : (
        <p role="alert" className="text-body-sm text-fg-danger pt-8">
          {error}
        </p>
      )}
    </SettingsCard>
  );
}
