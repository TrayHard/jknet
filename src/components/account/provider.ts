/**
 * Naming the sign-in providers the same way on every screen.
 *
 * --- slice: i18n ---
 * JKHub and Discord are proper nouns and stay as they are in every language;
 * `dev` is not one, so its two forms come from the `account` catalog. The hook
 * is what binds the three together — a component never spells a provider name
 * itself.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";

export interface ProviderNames {
  /** The provider inside a sentence: «signed in with the developer provider». */
  name: (provider: string) => string;
  /** The provider as a badge, where a sentence has no room: «Developer». */
  label: (provider: string) => string;
  /** The line under a name on the account card. */
  line: (provider: string, accountName: string) => string;
}

export function useProviderNames(): ProviderNames {
  const { t } = useTranslation("account");

  const name = useCallback(
    (provider: string) => {
      if (provider === "jkhub") return t("providers.jkhub");
      if (provider === "discord") return t("providers.discord");
      if (provider === "dev") return t("providers.dev");
      // A provider the service grew after this build shipped. Its own name is
      // a better answer than "unknown".
      return provider;
    },
    [t],
  );

  const label = useCallback(
    (provider: string) =>
      provider === "dev" ? t("providers.devLabel") : name(provider),
    [name, t],
  );

  const line = useCallback(
    (provider: string, accountName: string) =>
      t("providers.signedInAs", { provider: name(provider), name: accountName }),
    [name, t],
  );

  return { name, label, line };
}
