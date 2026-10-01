import { AlertTriangle, UserCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { useAccountState, useRegularsPrivacy, useSetShowInRegulars } from "../../lib/queries";
import { Toggle } from "../ui";

/** The anchor of the card: `#/settings?section=regulars`, where the Players tab of a community links. */
export const REGULARS_SECTION_ID = "settings-regulars";

/**
 * --- slice: communities ---
 *
 * **Show me in the regular players of communities**: the one switch of the
 * account's privacy in communities. Communities list the JKNet players who
 * play on their servers on three days or more a month; turning the switch
 * off takes the player out of every list and has JKNet Online forget the
 * days it counted. The setting lives on the service, for every device of the
 * account, and the card reads it when it mounts.
 */
export function RegularsPrivacyCard() {
  const { t } = useTranslation("community");
  const errorText = useErrorText();
  const account = useAccountState();
  const signedIn = account.data?.onlineSignedIn ?? false;
  const accountId = signedIn ? account.data?.onlineUser?.id ?? null : null;
  const setting = useRegularsPrivacy(accountId);
  const change = useSetShowInRegulars(accountId);
  const value = setting.data?.showInRegulars ?? null;
  const failure = change.error ?? setting.error;

  return (
    <section id={REGULARS_SECTION_ID} aria-labelledby={`${REGULARS_SECTION_ID}-title`} className="mb-24 flex flex-col gap-12 rounded-lg border border-line bg-surface p-16">
      <h2 id={`${REGULARS_SECTION_ID}-title`} className="flex items-center gap-8 text-heading-sm text-fg">
        <UserCheck size={16} className="text-fg-accent" aria-hidden="true" />
        {t("privacy.title")}
      </h2>
      {!signedIn ? (
        <p className="text-body-sm text-fg-secondary">{t("privacy.signedOut")}</p>
      ) : (
        <>
          <div className="flex items-start gap-16">
            <div className="flex min-w-0 flex-1 flex-col gap-4">
              <span id={`${REGULARS_SECTION_ID}-toggle`} className="text-body-md-medium text-fg">
                {t("privacy.toggle")}
              </span>
              <p className="text-body-sm text-fg-secondary">{t("privacy.text")}</p>
            </div>
            {value !== null ? (
              <Toggle
                checked={change.isPending && change.variables !== undefined ? change.variables : value}
                disabled={change.isPending}
                label={t("privacy.toggle")}
                onChange={(next) => change.mutate(next)}
              />
            ) : null}
          </div>
          {setting.isSuccess && value === null ? <p className="text-body-sm text-fg-muted">{t("privacy.unsupported")}</p> : null}
          {failure ? (
            <p role="alert" className="flex items-start gap-8 text-body-sm text-fg-danger">
              <AlertTriangle size={16} className="mt-1 shrink-0" aria-hidden="true" />
              <span>{errorText(failure)}</span>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
