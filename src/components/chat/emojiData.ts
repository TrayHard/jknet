/**
 * --- slice: chat ---
 *
 * The emoji of the picker, with their names and search words in the
 * language on screen, out of `emojibase-data`.
 *
 * Each language is its own chunk, fetched the first time the picker opens:
 * the data runs to half a megabyte per language and the launcher needs one.
 * A language `emojibase-data` does not have falls back to English.
 */

import type { Language } from "../../i18n/languages";

export interface EmojiEntry {
  unicode: string;
  label: string;
  tags?: string[];
  emoticon?: string | string[];
  group?: number;
  order?: number;
  skins?: EmojiEntry[];
}

export interface EmojiGroupName {
  key: string;
  message: string;
  order: number;
}

export interface EmojiData {
  emojis: EmojiEntry[];
  groups: EmojiGroupName[];
}

type Json<T> = Promise<{ default: T }>;

function load(compact: Json<EmojiEntry[]>, messages: Json<{ groups: EmojiGroupName[] }>): Promise<EmojiData> {
  return Promise.all([compact, messages]).then(([emoji, names]) => ({
    emojis: emoji.default,
    groups: names.default.groups,
  }));
}

/**
 * Written out per language rather than built from a template, so the bundler
 * sees every file it has to split off and nothing else of the package.
 */
function fetchLanguage(language: Language): Promise<EmojiData> {
  switch (language) {
    case "de":
      return load(import("emojibase-data/de/compact.json"), import("emojibase-data/de/messages.json"));
    case "es":
      return load(import("emojibase-data/es/compact.json"), import("emojibase-data/es/messages.json"));
    case "fr":
      return load(import("emojibase-data/fr/compact.json"), import("emojibase-data/fr/messages.json"));
    case "hu":
      return load(import("emojibase-data/hu/compact.json"), import("emojibase-data/hu/messages.json"));
    case "pl":
      return load(import("emojibase-data/pl/compact.json"), import("emojibase-data/pl/messages.json"));
    case "ru":
      return load(import("emojibase-data/ru/compact.json"), import("emojibase-data/ru/messages.json"));
    case "uk":
      return load(import("emojibase-data/uk/compact.json"), import("emojibase-data/uk/messages.json"));
    default:
      return load(import("emojibase-data/en/compact.json"), import("emojibase-data/en/messages.json"));
  }
}

const cache = new Map<Language, Promise<EmojiData>>();

/** The data of one language, fetched once per run. */
export function loadEmojiData(language: Language): Promise<EmojiData> {
  let pending = cache.get(language);
  if (pending === undefined) {
    pending = fetchLanguage(language).catch((error: unknown) => {
      cache.delete(language);
      throw error;
    });
    cache.set(language, pending);
  }
  return pending;
}

/** The group `emojibase` keeps for skin-tone swatches and hair parts: never offered. */
export const COMPONENT_GROUP = 2;
