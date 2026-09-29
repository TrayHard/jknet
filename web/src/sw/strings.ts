/**
 * The words of push notifications in all eight languages.
 *
 * `build-sw.mjs` reads the `push` section of every
 * `web/src/locales/<lang>/web.json` and bakes them in as `__PUSH_STRINGS__`,
 * so the worker needs no catalog download to write a notification while the
 * app is closed. A language the build does not know, or a word it lacks,
 * falls back to English, as the app's own i18next does.
 */

import type { PushStrings } from "./content.ts";

/** `{ "<lang>": { <push section> } }` as JSON: `define` flattens objects into strings. */
declare const __PUSH_STRINGS__: string;

const ALL = JSON.parse(__PUSH_STRINGS__) as Record<string, Partial<PushStrings>>;

export function stringsFor(lang: string): PushStrings {
  const english = ALL.en as PushStrings;
  return { ...english, ...(ALL[lang] ?? {}) };
}
