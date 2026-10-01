import { UserCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SettingsCard, ToggleRow } from "../../../../src/components/chat/settings/SettingRow.tsx";
import { useErrorText } from "../../../../src/i18n/errors.ts";
import { useAccountState, useRegularsPrivacy, useSetShowInRegulars } from "../../../../src/lib/queries.ts";

/**
 * Settings · Privacy: **Show me in the regular players of communities**, the
 * launcher's switch (`RegularsPrivacyCard`) in the cards of the web app.
 * Communities list the JKNet players the service counts as their regulars,
 * by its own rule; off, the player leaves every list and JKNet Online
 * forgets the play it counted. The switch is the account's: `PATCH /v1/me`
 * with the web session, read back from `GET /v1/me`.
 */
export function RegularsPrivacyRow() {
  const { t } = useTranslation("community");
  const errorText = useErrorText();
  const account = useAccountState().data;
  const accountId = account?.onlineSignedIn ? account.onlineUser?.id ?? null : null;
  const setting = useRegularsPrivacy(accountId);
  const change = useSetShowInRegulars(accountId);
  const value = setting.data?.showInRegulars ?? null;
  const failure = change.error ?? setting.error;

  return (
    <SettingsCard icon={<UserCheck size={20} />} title={t("privacy.title")} text={t("privacy.text")}>
      {accountId === null ? (
        <p className="text-body-sm text-fg-secondary">{t("privacy.signedOut")}</p>
      ) : setting.isSuccess && value === null ? (
        <p className="text-body-sm text-fg-muted">{t("privacy.unsupported")}</p>
      ) : (
        <ToggleRow
          title={t("privacy.toggle")}
          checked={change.isPending && change.variables !== undefined ? change.variables : value ?? true}
          disabled={value === null || change.isPending}
          onChange={(next) => change.mutate(next)}
        />
      )}
      {failure ? (
        <p role="alert" className="pt-8 text-body-sm text-fg-danger">
          {errorText(failure)}
        </p>
      ) : null}
    </SettingsCard>
  );
}
