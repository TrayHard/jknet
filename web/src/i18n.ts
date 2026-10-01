/**
 * The web app's translation layer.
 *
 * The launcher's `src/i18n/index.ts` globs every catalog it has; importing it
 * here would put all nineteen English namespaces into the phone's first
 * download. This loader globs one literal path per namespace the web app
 * reads (`WEB_NAMESPACES` of `i18nCatalogs.ts`) and runs i18next with the
 * launcher's options, so a shared component reads its strings exactly as it
 * does in the launcher. `check-bundle.mjs` fails the build if the launcher's
 * loader or a catalog outside the list reaches the bundle.
 *
 * English is bundled: it is the fallback of every other language. The other
 * seven languages are chunks, and only the one on screen is fetched.
 */

import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import {
  CYRILLIC_LANGUAGES,
  FALLBACK_LANGUAGE,
  isLanguage,
  languageOfLocale,
  type Language,
} from "../../src/i18n/languages.ts";
import { englishResources, loadCatalogs, WEB_NAMESPACES, type Catalog } from "./i18nCatalogs.ts";

/** English, inlined: one literal path per namespace of `WEB_NAMESPACES`. */
const ENGLISH = import.meta.glob<Catalog>(
  [
    "../../src/locales/en/common.json",
    "../../src/locales/en/errors.json",
    "../../src/locales/en/games.json",
    "../../src/locales/en/friends.json",
    "../../src/locales/en/chat.json",
    "../../src/locales/en/account.json",
    "../../src/locales/en/servers.json",
    "../../src/locales/en/bundles.json",
    "../../src/locales/en/host.json",
    "../../src/locales/en/clients.json",
    "../../src/locales/en/library.json",
    "../../src/locales/en/pk3.json",
    "../../src/locales/en/jkhub.json",
    "../../src/locales/en/community.json",
    "./locales/en/web.json",
  ],
  { eager: true, import: "default" },
);

/** Every other language of the same namespaces, one chunk per file. */
const TRANSLATED = import.meta.glob<Catalog>(
  [
    "../../src/locales/*/common.json",
    "../../src/locales/*/errors.json",
    "../../src/locales/*/games.json",
    "../../src/locales/*/friends.json",
    "../../src/locales/*/chat.json",
    "../../src/locales/*/account.json",
    "../../src/locales/*/servers.json",
    "../../src/locales/*/bundles.json",
    "../../src/locales/*/host.json",
    "../../src/locales/*/clients.json",
    "../../src/locales/*/library.json",
    "../../src/locales/*/pk3.json",
    "../../src/locales/*/jkhub.json",
    "../../src/locales/*/community.json",
    "!../../src/locales/en/*.json",
    "./locales/*/web.json",
    "!./locales/en/*.json",
  ],
  { import: "default" },
);

/** What a non-production build counts for the e2e run. */
interface MissingKeyStats {
  missingKeys: number;
  missingKeyList: string[];
}

const loaded = new Set<Language>([FALLBACK_LANGUAGE]);

async function loadLanguage(language: Language): Promise<void> {
  if (loaded.has(language)) return;
  for (const file of await loadCatalogs(language, TRANSLATED)) {
    i18next.addResourceBundle(language, file.namespace, file.catalog, true, true);
  }
  loaded.add(language);
}

/** The language the browser asks for, among the eight JKNet speaks. */
export function browserLanguage(): Language {
  const candidates = typeof navigator === "undefined" ? [] : [...(navigator.languages ?? []), navigator.language];
  for (const locale of candidates) {
    const language = languageOfLocale(locale);
    if (language !== null) return language;
  }
  return FALLBACK_LANGUAGE;
}

/** The stored language when there is one, else the browser's. */
export function startLanguage(stored: unknown): Language {
  return isLanguage(stored) ? stored : browserLanguage();
}

/** Whether a language needs the Cyrillic display face. */
export function needsCyrillicDisplayFont(language: Language): boolean {
  return CYRILLIC_LANGUAGES.includes(language);
}

/**
 * Starts i18next with the launcher's options, in `language`.
 *
 * `stats`, when given (non-production builds), counts every key no catalog
 * has, English included: the e2e run fails on any.
 */
export async function initWebI18n(language: Language, stats?: MissingKeyStats): Promise<void> {
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      lng: FALLBACK_LANGUAGE,
      fallbackLng: FALLBACK_LANGUAGE,
      supportedLngs: false,
      ns: [...WEB_NAMESPACES],
      defaultNS: "common",
      resources: { [FALLBACK_LANGUAGE]: englishResources(ENGLISH) },
      returnNull: false,
      returnEmptyString: false,
      interpolation: { escapeValue: false },
      pluralSeparator: "_",
      react: { useSuspense: false },
      saveMissing: stats !== undefined,
      missingKeyHandler:
        stats === undefined
          ? false
          : (_languages, namespace, key) => {
              stats.missingKeys += 1;
              stats.missingKeyList.push(`${namespace}:${key}`);
            },
    });
  }
  await changeWebLanguage(language);
}

/** Loads a language's chunks, then switches to it. */
export async function changeWebLanguage(language: Language): Promise<void> {
  await loadLanguage(language);
  if (i18next.language !== language) await i18next.changeLanguage(language);
  if (typeof document !== "undefined") document.documentElement.lang = language;
}

export { i18next };
