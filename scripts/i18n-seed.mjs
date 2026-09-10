#!/usr/bin/env node
/**
 * Fills the gaps in a language folder from English.
 *
 * A translator edits one folder; a developer adding a string edits English and
 * runs this. It writes every key English has and no other, keeps whatever the
 * folder already translated, and expands a plural into the forms that language
 * actually uses — Russian needs `_one`, `_few` and `_many` where English has
 * two forms, and no translator should have to remember that.
 *
 * It never overwrites a translated value: what it copies is the English text of
 * a key the folder does not have yet. Running it twice changes nothing.
 *
 * Usage:
 *   node scripts/i18n-seed.mjs            every language
 *   node scripts/i18n-seed.mjs uk pl      only these
 *
 * Node only, no dependencies. `npm run i18n:check` is what verifies the result.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES = join(ROOT, "src", "locales");
const SOURCE_LANGUAGE = "en";

const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"];

/** The plural categories a language's numbers need, as CLDR has them. */
function pluralCategories(language) {
  return new Intl.PluralRules(language).resolvedOptions().pluralCategories;
}

/**
 * Rewrites one object of the English catalog for `language`.
 *
 * `existing` is what the folder already holds at the same place, so a value a
 * translator wrote survives. Anything English no longer has is dropped: a key
 * left behind after a rename is a key nobody would ever notice again.
 */
function seed(english, existing, categories) {
  const out = {};
  const plurals = new Map();

  for (const [key, value] of Object.entries(english)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const below =
        existing !== undefined && existing !== null && typeof existing === "object"
          ? existing[key]
          : undefined;
      out[key] = seed(value, below, categories);
      continue;
    }

    const at = key.lastIndexOf("_");
    const suffix = at < 0 ? "" : key.slice(at + 1);
    if (PLURAL_SUFFIXES.includes(suffix)) {
      const base = key.slice(0, at);
      const forms = plurals.get(base) ?? {};
      forms[suffix] = value;
      plurals.set(base, forms);
      continue;
    }

    const mine = existing?.[key];
    out[key] = typeof mine === "string" && mine.trim() !== "" ? mine : value;
  }

  for (const [base, forms] of plurals) {
    // The English `other` is the text every form of the new language starts
    // from: it is the one form every language has, and the one whose wording
    // carries no assumption about the count.
    const fallback = forms.other ?? forms.one ?? Object.values(forms)[0];
    for (const category of categories) {
      const key = `${base}_${category}`;
      const mine = existing?.[key];
      out[key] =
        typeof mine === "string" && mine.trim() !== ""
          ? mine
          : (forms[category] ?? fallback);
    }
  }

  return out;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const asked = process.argv.slice(2);
const languages = (
  asked.length > 0
    ? asked
    : readdirSync(LOCALES).filter((name) => name !== SOURCE_LANGUAGE)
).filter((name) => name !== SOURCE_LANGUAGE);

const namespaces = readdirSync(join(LOCALES, SOURCE_LANGUAGE))
  .filter((name) => name.endsWith(".json") && !name.startsWith("_"))
  .sort();

for (const language of languages) {
  const folder = join(LOCALES, language);
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
  const categories = pluralCategories(language);

  for (const namespace of namespaces) {
    const english = readJson(join(LOCALES, SOURCE_LANGUAGE, namespace));
    const target = join(folder, namespace);
    const existing = existsSync(target) ? readJson(target) : {};
    writeJson(target, seed(english, existing, categories));
  }

  console.log(`${language}: ${namespaces.length} namespaces, plurals ${categories.join("/")}`);
}
