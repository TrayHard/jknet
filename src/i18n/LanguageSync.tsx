/**
 * Keeps the interface in the language the settings name.
 *
 * `main.tsx` picks the language before React mounts, so this component is not
 * what makes the first frame right. It is what makes every frame after a write
 * right: the Settings row sends a patch, the answer replaces the settings
 * document in the query cache, and this effect loads the catalog and switches.
 * A `settings.json` edited by hand while the launcher is open takes the same
 * path on the next refetch.
 *
 * It renders nothing. Mounting it inside the query provider and above the
 * router is what keeps a language switch from unmounting the screen the player
 * is on.
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useSettings } from "../lib/queries";
import { changeLanguage } from "./index";
import { resolveLanguage } from "./languages";
import { useSystemLocale } from "./useSystemLocale";

export function LanguageSync() {
  const settings = useSettings();
  const { i18n } = useTranslation();
  const systemLocale = useSystemLocale();
  const setting = settings.data?.language;

  useEffect(() => {
    // Nothing to follow until the first read answers. Until then the language
    // `main.tsx` resolved stands, which was resolved from the same two inputs.
    if (setting === undefined) return;
    const wanted = resolveLanguage(setting, systemLocale);
    if (wanted === i18n.language) return;
    void changeLanguage(wanted);
  }, [setting, systemLocale, i18n.language]);

  return null;
}
