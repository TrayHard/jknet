/**
 * The launcher's translation layer.
 *
 * English is bundled with the app and is the fallback of every other language,
 * key by key. The other seven catalogs are separate chunks: Vite splits each
 * `src/locales/<lang>/` folder out of the main bundle, and only the language
 * the player is in is fetched. A launcher in English therefore downloads and
 * parses nothing extra.
 *
 * There is no HTTP backend and no `Suspense`. The catalog is loaded once,
 * before React mounts — `main.tsx` awaits [`bootstrapI18n`] — so no screen ever
 * renders a key instead of a sentence, and a language switch at runtime is a
 * dynamic import followed by one re-render.
 *
 * Fallbacks are deliberately flat: every language falls back to English and to
 * nothing else. A chain — Ukrainian to Russian, say — would put a language the
 * player did not choose on screen and would hide the gap from the check
 * script.
 */

import i18next, { type i18n as I18n } from "i18next";
import { initReactI18next } from "react-i18next";

import {
  CYRILLIC_LANGUAGES,
  FALLBACK_LANGUAGE,
  isLanguage,
  resolveLanguage,
  translationState,
  type Language,
  type LanguageSetting,
  type LanguageStatus,
  type TranslationState,
} from "./languages";

export {
  CYRILLIC_LANGUAGES,
  FALLBACK_LANGUAGE,
  LANGUAGES,
  LANGUAGE_IDS,
  isLanguage,
  isLanguageSetting,
  languageOfLocale,
  resolveLanguage,
  translationState,
  type Language,
  type LanguageSetting,
  type LanguageStatus,
  type TranslationState,
} from "./languages";

/**
 * The namespaces, one file per catalog folder.
 *
 * A namespace is a screen or a cross-cutting subject, not a component: a
 * string moves between components far more often than between screens, and a
 * key that has to be renamed on every refactor is a key nobody keeps stable.
 */
export const NAMESPACES = [
  "common",
  "nav",
  "home",
  "servers",
  "clients",
  "library",
  "jkhub",
  "friends",
  "account",
  "settings",
  "onboarding",
  "errors",
  "games",
  "update",
] as const;

export type Namespace = (typeof NAMESPACES)[number];

/** The namespace a `t` without one reads from. */
export const DEFAULT_NAMESPACE: Namespace = "common";

type Catalog = Record<string, unknown>;

/**
 * English, inlined into the main bundle.
 *
 * Eager on purpose: it is the fallback of every other language, so it has to
 * be in memory whatever the player picked, and fetching it as a chunk would
 * only add a round trip to the first paint.
 */
const ENGLISH = import.meta.glob<Catalog>("../locales/en/*.json", {
  eager: true,
  import: "default",
});

/**
 * Every other catalog, as a loader per file.
 *
 * Vite turns each entry into its own chunk. English is excluded by the second
 * pattern: a file that is both eagerly and lazily imported ends up in the main
 * bundle either way, and Rollup says so once per namespace.
 *
 * The keys are the paths, which is why they are rebuilt by hand below rather
 * than parsed: a path that stops matching is a build error here instead of a
 * missing string on screen.
 */
const TRANSLATED = import.meta.glob<Catalog>(
  ["../locales/*/*.json", "!../locales/en/*.json", "!../locales/*/_status.json"],
  { import: "default" },
);

/**
 * The `_status.json` of every folder, inlined into the main bundle.
 *
 * Eager, and excluded from the lazy glob above, because these markers are read
 * on the Settings screen for a language the player has not switched to yet: a
 * chunk per marker would be seven round trips to draw one hint. Eight objects
 * of four fields cost less than the code that would fetch them.
 */
const STATUSES = import.meta.glob<LanguageStatus>("../locales/*/_status.json", {
  eager: true,
  import: "default",
});

/** The catalog path of one namespace of one language. */
function catalogPath(language: Language, namespace: Namespace): string {
  return `../locales/${language}/${namespace}.json`;
}

/** English as i18next wants it: one object per namespace. */
function englishResources(): Record<string, Catalog> {
  const resources: Record<string, Catalog> = {};
  for (const namespace of NAMESPACES) {
    const catalog = ENGLISH[catalogPath(FALLBACK_LANGUAGE, namespace)];
    if (catalog !== undefined) resources[namespace] = catalog;
  }
  return resources;
}

/** Languages whose chunks are already in memory. */
const loaded = new Set<Language>([FALLBACK_LANGUAGE]);

/**
 * Fetches the chunks of one language and hands them to i18next.
 *
 * A namespace whose file failed to load is left out rather than filled with
 * anything: i18next then answers from English, which is the same fallback a
 * missing key gets. Loading twice is free — the set above short-circuits, and
 * the browser caches the chunk anyway.
 */
export async function loadLanguage(language: Language): Promise<void> {
  if (loaded.has(language)) return;

  const files = await Promise.all(
    NAMESPACES.map(async (namespace) => {
      const load = TRANSLATED[catalogPath(language, namespace)];
      if (load === undefined) return null;
      try {
        return { namespace, catalog: await load() };
      } catch (error) {
        console.warn(`i18n: ${language}/${namespace}.json did not load`, error);
        return null;
      }
    }),
  );

  for (const file of files) {
    if (file === null) continue;
    i18next.addResourceBundle(language, file.namespace, file.catalog, true, true);
  }
  loaded.add(language);
}

/**
 * Puts the language on the document.
 *
 * Two things read it. The browser uses it for hyphenation, spell checking and
 * the voice a screen reader picks, and `src/styles/fonts.css` uses it to swap
 * the display face for the Cyrillic languages, whose headings Chakra Petch
 * cannot draw.
 */
export function applyDocumentLanguage(language: Language): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = language;
}

/** Whether this language needs the Cyrillic display face. */
export function needsCyrillicDisplayFont(language: Language): boolean {
  return CYRILLIC_LANGUAGES.includes(language);
}

/**
 * How far the catalog of one language has come, out of its own `_status.json`.
 *
 * The Settings screen asks this to decide which sentence to put under the
 * **Language** card. Reading the marker rather than a list in the component is
 * the point: a folder that gets reviewed stops warning about itself in the
 * same edit that records the reviewer, and no screen has to be found and
 * changed for it.
 */
export function translationStateOf(language: Language): TranslationState {
  return translationState(STATUSES[`../locales/${language}/_status.json`]);
}

/**
 * Switches the interface language, loading its catalog first.
 *
 * Safe to call with the language already in force: the load is a no-op and
 * i18next skips the change.
 */
export async function changeLanguage(language: Language): Promise<void> {
  await loadLanguage(language);
  if (i18next.language !== language) await i18next.changeLanguage(language);
  applyDocumentLanguage(language);
}

/**
 * Starts i18next in English and returns the instance.
 *
 * Synchronous, because English is already in the bundle. The language the
 * player asked for arrives through [`bootstrapI18n`] a moment later.
 */
export function initI18n(): I18n {
  if (i18next.isInitialized) return i18next;

  void i18next.use(initReactI18next).init({
    lng: FALLBACK_LANGUAGE,
    fallbackLng: FALLBACK_LANGUAGE,
    supportedLngs: false,
    ns: [...NAMESPACES],
    defaultNS: DEFAULT_NAMESPACE,
    resources: { [FALLBACK_LANGUAGE]: englishResources() },
    // A missing key answers with its English text, never with `null`: the
    // types promise `string`, and a blank line on screen says less than a
    // sentence in the wrong language.
    returnNull: false,
    returnEmptyString: false,
    interpolation: {
      // React escapes everything it renders, and a second pass would turn an
      // apostrophe in a server name into `&#39;` on screen.
      escapeValue: false,
    },
    // JSON v4: the plural suffixes are the CLDR categories of the language,
    // which `Intl.PluralRules` decides. Russian, Ukrainian and Polish need
    // `_one`, `_few`, `_many` and `_other`; English needs two of them.
    pluralSeparator: "_",
    react: { useSuspense: false },
  });

  applyDocumentLanguage(FALLBACK_LANGUAGE);
  return i18next;
}

/**
 * The language a dev preview was asked for through `?lng=ru`.
 *
 * Development only: `npm run dev` opens the app in a plain browser with no
 * settings document to read, and switching language through the Settings row
 * there would mean a Tauri command that cannot answer. The parameter is read
 * out of the hash as well, because the app routes on `#/`.
 */
function devLanguageOverride(): Language | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const search = new URLSearchParams(window.location.search);
  const hash = window.location.hash;
  const inHash = hash.includes("?")
    ? new URLSearchParams(hash.slice(hash.indexOf("?") + 1))
    : null;
  const asked = search.get("lng") ?? inHash?.get("lng") ?? null;
  return isLanguage(asked) ? asked : null;
}

/**
 * Brings up i18next in the language the player will see.
 *
 * `main.tsx` awaits this before it mounts React, so the first frame is already
 * in the right language: a window that paints English and corrects itself is
 * both a flash and a layout jump — «Настройки» is not the width of «Settings».
 *
 * Neither input is required. A settings read that fails, an operating system
 * that reports no locale and a plain browser all end at the same place: the
 * language of the system, and English when that is not one JKNet speaks.
 */
export async function bootstrapI18n(
  setting: LanguageSetting | string | null | undefined,
  systemLocale: string | null | undefined,
): Promise<Language> {
  initI18n();
  const language = devLanguageOverride() ?? resolveLanguage(setting, systemLocale);
  await changeLanguage(language);
  return language;
}

export { i18next };
