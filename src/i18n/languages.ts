/**
 * The languages the launcher speaks, and the rules that pick one.
 *
 * Nothing here imports i18next or React: the resolution is a pure function of
 * a stored setting and an operating system locale, so it can be read and
 * reasoned about without a running app. `index.ts` is the part that wires it
 * to i18next.
 *
 * English is the source language. Every other catalog falls back to it key by
 * key — no chains between languages, so a missing Ukrainian string shows the
 * English one rather than a Russian one.
 */

/** A language the launcher ships a catalog for. */
export type Language = "en" | "ru" | "uk" | "de" | "fr" | "es" | "pl" | "hu";

/** What `settings.language` may hold: a language, or "follow the system". */
export type LanguageSetting = Language | "system";

/** The source language every other catalog falls back to. */
export const FALLBACK_LANGUAGE: Language = "en";

/**
 * Every language, in the order the Settings list shows them.
 *
 * English first, then the rest by the native name. `nativeName` is what the
 * list prints: a player looking for their language reads it in that language,
 * not in the one the launcher happens to be in.
 */
export const LANGUAGES: ReadonlyArray<{
  id: Language;
  /** The name of the language in that language. Never translated. */
  nativeName: string;
}> = [
  { id: "en", nativeName: "English" },
  { id: "de", nativeName: "Deutsch" },
  { id: "es", nativeName: "Español" },
  { id: "fr", nativeName: "Français" },
  { id: "hu", nativeName: "Magyar" },
  { id: "pl", nativeName: "Polski" },
  { id: "ru", nativeName: "Русский" },
  { id: "uk", nativeName: "Українська" },
];

/** The ids alone, for a lookup or a validation. */
export const LANGUAGE_IDS: readonly Language[] = LANGUAGES.map((entry) => entry.id);

/**
 * The languages whose display font has to be swapped.
 *
 * Chakra Petch, the display face of the design, ships Latin and Latin Extended
 * and no Cyrillic at all, so a heading in Russian would fall back to whatever
 * the system picks. `src/styles/fonts.css` gives these two Exo 2 instead.
 */
export const CYRILLIC_LANGUAGES: readonly Language[] = ["ru", "uk"];

/** Whether a string from a settings file or a query names a language. */
export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGE_IDS as readonly string[]).includes(value);
}

/** Whether a string names a language or the "system" setting. */
export function isLanguageSetting(value: unknown): value is LanguageSetting {
  return value === "system" || isLanguage(value);
}

/**
 * The language a locale tag names, by its primary subtag.
 *
 * `de-AT` is German, `pt-BR` is a language the launcher has no catalog for and
 * therefore English. Matching on the primary subtag alone is deliberate: the
 * catalogs are per language, and a regional catalog would be a promise the
 * project cannot keep in eight languages.
 */
export function languageOfLocale(locale: string | null | undefined): Language | null {
  const primary = (locale ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return isLanguage(primary) ? primary : null;
}

/**
 * The language to start in.
 *
 * The setting wins whenever it names one. `system` — the default — asks the
 * operating system, and anything the launcher has no catalog for ends at
 * English rather than at a blank screen.
 */
export function resolveLanguage(
  setting: LanguageSetting | string | null | undefined,
  systemLocale: string | null | undefined,
): Language {
  if (isLanguage(setting)) return setting;
  return languageOfLocale(systemLocale) ?? FALLBACK_LANGUAGE;
}
