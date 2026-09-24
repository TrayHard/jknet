/**
 * --- slice: bundles ---
 *
 * The name, the summary and the description of a bundle in the language on
 * screen.
 *
 * A bundle is written in one language and may carry translations into the
 * others the launcher speaks. What a player reads is the translation into
 * the interface language where the author wrote one, field by field, and the
 * default language for the rest: an empty field of a translation is «not
 * translated», not «blank». The choice is pure and takes its inputs as
 * arguments — the card or the record, and the language wanted — so the same
 * function serves the catalogue, the record, the preview of a draft and a
 * draft itself, which carries the same five fields.
 */

import { useTranslation } from "react-i18next";

import { FALLBACK_LANGUAGE, LANGUAGES } from "../i18n/languages";
import type { Translation } from "./ipc";

/** What the choice reads: the fields of a card, a record or a draft. */
export interface BundleText {
  name: string;
  summary: string;
  /** Absent on a card of the catalogue list, which carries no description. */
  description?: string;
  language: string;
  translations: Record<string, Translation>;
}

/** The three texts in one language, and which language they came from. */
export interface LocalizedBundleText {
  name: string;
  summary: string;
  /** Empty for a card of the catalogue list. */
  description: string;
  /** `language` of the call when the bundle has a translation into it, the default language otherwise. */
  language: string;
}

/**
 * The code a language of the interface is compared by: the primary subtag,
 * lowercased. `i18n.language` is one of the launcher's own codes, but a tag
 * with a region would still name its language.
 */
export function interfaceLanguageCode(tag: string | null | undefined): string {
  const primary = (tag ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return primary === "" ? FALLBACK_LANGUAGE : primary;
}

/** The interface language as a bundle code, for the screens that read a bundle. */
export function useInterfaceLanguage(): string {
  const { i18n } = useTranslation();
  return interfaceLanguageCode(i18n.language);
}

/** A field of a translation that says something, or the same field of the default language. */
function pick(translated: string | undefined, fallback: string): string {
  return translated !== undefined && translated.trim() !== "" ? translated : fallback;
}

/**
 * The texts of a bundle in `language`, falling back to its default language
 * field by field.
 *
 * A service from before translations sends neither `language` nor
 * `translations`; such a record reads as English with no translation, which
 * is what it was.
 */
export function localizedBundleText(bundle: BundleText, language: string): LocalizedBundleText {
  const base = bundle.language || FALLBACK_LANGUAGE;
  const translations = bundle.translations ?? {};
  const translation = language !== base ? translations[language] : undefined;
  return {
    name: pick(translation?.name, bundle.name),
    summary: pick(translation?.summary, bundle.summary),
    description: pick(translation?.description, bundle.description ?? ""),
    language: translation === undefined ? base : language,
  };
}

/**
 * The codes of the languages a bundle is written in: the default first, then
 * the translations in the order of the launcher's language list, and any
 * code the list does not know after them.
 */
export function bundleLanguages(bundle: Pick<BundleText, "language" | "translations">): string[] {
  const base = bundle.language || FALLBACK_LANGUAGE;
  const others = Object.keys(bundle.translations ?? {}).filter((code) => code !== base);
  const rank = (code: string) => {
    const index = LANGUAGES.findIndex((entry) => entry.id === code);
    return index < 0 ? LANGUAGES.length : index;
  };
  others.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return [base, ...others];
}

/**
 * The language a record opens in: the interface language when the bundle
 * has a translation into it, its default language otherwise.
 */
export function preferredBundleLanguage(
  bundle: Pick<BundleText, "language" | "translations">,
  interfaceLanguage: string,
): string {
  const base = bundle.language || FALLBACK_LANGUAGE;
  if (interfaceLanguage === base) return base;
  return interfaceLanguage in (bundle.translations ?? {}) ? interfaceLanguage : base;
}

/** `EN`, `RU`: the code as a badge prints it. */
export function languageCode(code: string): string {
  return code.toUpperCase();
}

/**
 * The name of a language in that language, out of the launcher's list —
 * «Русский», «Deutsch» — or its code in capitals for one the list does not
 * know. Never translated: a player looking for their language reads it in
 * that language.
 */
export function languageName(code: string): string {
  return LANGUAGES.find((entry) => entry.id === code)?.nativeName ?? languageCode(code);
}
