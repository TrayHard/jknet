#!/usr/bin/env node
/**
 * Guards the translation catalogs and the screens that read them.
 *
 * Two checks, both of which fail the build:
 *
 *  1. Every language folder under `src/locales/` holds exactly the namespaces
 *     and keys English holds, with the same `{{placeholders}}`, the plural
 *     forms that language's CLDR rules ask for, and no empty value.
 *  2. No `.tsx` file under `src/` prints a sentence of its own: JSX text nodes
 *     and the `placeholder`, `title`, `aria-label` and `alt` attributes have to
 *     come from `t()`. Names and tokens are allowed, and the list of them is
 *     `scripts/i18n-allowlist.json`.
 *
 * Node only, no dependencies: it runs from `prebuild`, so a missing package
 * would break every build rather than one check.
 *
 * Usage: `npm run i18n:check`. It prints every finding and exits 1 on any.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES = join(ROOT, "src", "locales");
const SOURCE = join(ROOT, "src");
const SOURCE_LANGUAGE = "en";

/** Attributes whose value the player reads. */
const TEXT_ATTRIBUTES = ["placeholder", "title", "aria-label", "alt"];

/** Two letters in a row, Latin or Cyrillic: what makes a string a sentence. */
const LETTERS = /[A-Za-zЀ-ӿ]{2}/;

const problems = [];

function fail(where, message) {
  problems.push(`${where}: ${message}`);
}

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------

/** `{ "a.b": "text" }` out of a nested catalog. */
function flatten(value, prefix = "", into = {}) {
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      flatten(entry, path, into);
    } else {
      into[path] = entry;
    }
  }
  return into;
}

/**
 * Splits a key into its base and its plural suffix.
 *
 * A key ends in a plural suffix only when the suffix is a CLDR category, so
 * `card.other` — a category of library files — is not read as a plural of
 * `card`.
 */
const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"];

function splitPlural(key, pluralBases) {
  const at = key.lastIndexOf("_");
  if (at < 0) return { base: key, suffix: null };
  const suffix = key.slice(at + 1);
  const base = key.slice(0, at);
  if (!PLURAL_SUFFIXES.includes(suffix)) return { base: key, suffix: null };
  // The English catalog decides what is a plural. Without this a language
  // could invent one and the check would compare it against nothing.
  if (pluralBases !== null && !pluralBases.has(base)) return { base: key, suffix: null };
  return { base, suffix };
}

/** The `{{name}}` placeholders of one message, as a sorted list. */
function placeholders(text) {
  const found = new Set();
  for (const match of String(text).matchAll(/\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g)) {
    found.add(match[1]);
  }
  return [...found].sort();
}

/** The plural categories this language's numbers actually need. */
function pluralCategories(language) {
  return new Set(new Intl.PluralRules(language).resolvedOptions().pluralCategories);
}

/** Namespaces of one folder: every `.json` that is not a marker file. */
function namespacesOf(folder) {
  return readdirSync(folder)
    .filter((name) => name.endsWith(".json") && !name.startsWith("_"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

function readCatalog(language, namespace) {
  const file = join(LOCALES, language, `${namespace}.json`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${language}/${namespace}.json`, `cannot be read: ${error.message}`);
    return null;
  }
}

/** The keys of one namespace, grouped by base key. */
function describe(flat, pluralBases) {
  const plain = new Map();
  const plurals = new Map();
  for (const [key, value] of Object.entries(flat)) {
    const { base, suffix } = splitPlural(key, pluralBases);
    if (suffix === null) {
      plain.set(base, value);
    } else {
      const forms = plurals.get(base) ?? new Map();
      forms.set(suffix, value);
      plurals.set(base, forms);
    }
  }
  return { plain, plurals };
}

function checkCatalogs() {
  const languages = readdirSync(LOCALES).filter((name) =>
    statSync(join(LOCALES, name)).isDirectory(),
  );
  if (!languages.includes(SOURCE_LANGUAGE)) {
    fail("src/locales", `there is no ${SOURCE_LANGUAGE} folder to check against`);
    return;
  }

  const namespaces = namespacesOf(join(LOCALES, SOURCE_LANGUAGE));
  if (namespaces.length === 0) {
    fail(`src/locales/${SOURCE_LANGUAGE}`, "holds no namespace");
    return;
  }

  // English first: it is the shape every other folder is measured against.
  const source = new Map();
  for (const namespace of namespaces) {
    const catalog = readCatalog(SOURCE_LANGUAGE, namespace);
    if (catalog === null) continue;
    const flat = flatten(catalog);
    const bases = new Set(
      Object.keys(flat)
        .map((key) => splitPlural(key, null))
        .filter((split) => split.suffix !== null)
        .map((split) => split.base),
    );
    source.set(namespace, { flat, bases, ...describe(flat, bases) });
  }

  /** What `_status.json` may say about a folder. */
  const STATES = new Set(["source", "translated", "needs-translation"]);

  for (const language of languages) {
    // The marker is how a reader — and the report of a release — tells a
    // translated folder from one that still holds the English text.
    const marker = join(LOCALES, language, "_status.json");
    try {
      const status = JSON.parse(readFileSync(marker, "utf8"));
      if (!STATES.has(status.state)) {
        fail(`${language}/_status.json`, `state ${JSON.stringify(status.state)} is unknown`);
      }
    } catch (error) {
      fail(`${language}/_status.json`, `is missing or unreadable: ${error.message}`);
    }

    const own = namespacesOf(join(LOCALES, language));
    for (const missing of namespaces.filter((one) => !own.includes(one))) {
      fail(`${language}`, `${missing}.json is missing`);
    }
    for (const extra of own.filter((one) => !namespaces.includes(one))) {
      fail(`${language}`, `${extra}.json is not a namespace of ${SOURCE_LANGUAGE}`);
    }

    const categories = pluralCategories(language);

    for (const namespace of namespaces) {
      const english = source.get(namespace);
      if (english === undefined || !own.includes(namespace)) continue;
      const catalog = readCatalog(language, namespace);
      if (catalog === null) continue;
      const where = `${language}/${namespace}.json`;
      const theirs = describe(flatten(catalog), english.bases);

      for (const [key, value] of theirs.plain) {
        if (!english.plain.has(key)) {
          fail(where, `${key} is not a key of ${SOURCE_LANGUAGE}`);
        }
        if (typeof value !== "string") {
          fail(where, `${key} is not a string`);
        } else if (value.trim() === "") {
          fail(where, `${key} is empty`);
        }
      }
      for (const key of english.plain.keys()) {
        if (!theirs.plain.has(key)) fail(where, `${key} is missing`);
      }

      for (const [key, forms] of english.plurals) {
        const ours = theirs.plurals.get(key);
        if (ours === undefined) {
          fail(where, `${key} has no plural forms`);
          continue;
        }
        const have = new Set(ours.keys());
        for (const category of categories) {
          if (!have.has(category)) fail(where, `${key}_${category} is missing`);
        }
        for (const category of have) {
          if (!categories.has(category)) {
            fail(where, `${key}_${category} is not a plural form ${language} uses`);
          }
        }
        // Every form is measured against the English `other`, which is the
        // form every language has.
        const wanted = placeholders(forms.get("other") ?? [...forms.values()][0]);
        for (const [category, value] of ours) {
          if (typeof value !== "string" || value.trim() === "") {
            fail(where, `${key}_${category} is empty`);
            continue;
          }
          const mine = placeholders(value);
          if (mine.join(",") !== wanted.join(",")) {
            fail(
              where,
              `${key}_${category} has {{${mine.join("}}, {{")}}} where ${SOURCE_LANGUAGE} has {{${wanted.join("}}, {{")}}}`,
            );
          }
        }
      }
      for (const key of theirs.plurals.keys()) {
        if (!english.plurals.has(key)) {
          fail(where, `${key} is not a plural key of ${SOURCE_LANGUAGE}`);
        }
      }

      for (const [key, value] of english.plain) {
        const mine = theirs.plain.get(key);
        if (typeof mine !== "string") continue;
        const wanted = placeholders(value);
        const got = placeholders(mine);
        if (got.join(",") !== wanted.join(",")) {
          fail(
            where,
            `${key} has {{${got.join("}}, {{")}}} where ${SOURCE_LANGUAGE} has {{${wanted.join("}}, {{")}}}`,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Literals in the screens
// ---------------------------------------------------------------------------

const allowlist = JSON.parse(
  readFileSync(join(ROOT, "scripts", "i18n-allowlist.json"), "utf8"),
);
const ALLOWED_WORDS = new Set(allowlist.words ?? []);
const ALLOWED_EXACT = new Set(allowlist.exact ?? []);
const SKIPPED_FILES = new Set(
  Object.keys(allowlist.files ?? {}).filter((key) => key !== "comment"),
);

/** Whether a candidate is nothing but names, tokens and punctuation. */
function isAllowed(text) {
  const trimmed = text.trim();
  if (trimmed === "" || !LETTERS.test(trimmed)) return true;
  if (ALLOWED_EXACT.has(trimmed)) return true;
  // Every run of letters has to be an allowed word. Splitting on everything
  // else is what lets `+set fs_game` and `clients\everyday` through while
  // «Install the engine first» is caught.
  const words = trimmed.split(/[^A-Za-z0-9_Ѐ-ӿ]+/).filter(Boolean);
  return words.every((word) => ALLOWED_WORDS.has(word) || !LETTERS.test(word));
}

/** Comments hold English on purpose, so they are removed before the scan. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");
}

function tsxFiles(folder, into = []) {
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) tsxFiles(path, into);
    else if (name.endsWith(".tsx")) into.push(path);
  }
  return into;
}

function checkLiterals() {
  for (const file of tsxFiles(SOURCE)) {
    const shown = relative(ROOT, file).replace(/\\/g, "/");
    if (SKIPPED_FILES.has(shown)) continue;
    const source = stripComments(readFileSync(file, "utf8"));

    for (const attribute of TEXT_ATTRIBUTES) {
      const pattern = new RegExp(`\\b${attribute}\\s*=\\s*"([^"]*)"`, "g");
      for (const match of source.matchAll(pattern)) {
        if (!isAllowed(match[1])) {
          fail(shown, `${attribute}="${match[1]}" is not translated`);
        }
      }
    }

    // A JSX text node, anchored on a real tag boundary at one end.
    //
    // The first pattern is the common shape — text that runs into a closing
    // tag. The second catches text that starts after one. Both anchors matter:
    // a bare `>` … `<` also matches `Promise<void>` and `a > b`, which is a
    // page of noise from every generic in the file.
    const patterns = [
      { pattern: />([^<>{}]*[A-Za-zЀ-ӿ][^<>{}]*?)<\//g, code: null },
      // Anchored at one end only, so a ternary between two elements —
      // `</Badge>\n ) : update.data ? (\n <Badge` — has to be excluded by
      // what it is made of. Prose in a JSX text node carries no `;`, `=` or
      // parenthesis; a sentence that does is missed rather than reported.
      {
        pattern: /<\/[A-Za-z][\w.]*>([^<>{}]*[A-Za-zЀ-ӿ][^<>{}]*?)</g,
        code: /[();=]/,
      },
    ];
    const seen = new Set();
    for (const { pattern, code } of patterns) {
      for (const match of source.matchAll(pattern)) {
        const text = match[1];
        if (code !== null && code.test(text)) continue;
        if (seen.has(text) || isAllowed(text)) continue;
        seen.add(text);
        fail(shown, `the text ${JSON.stringify(text.trim())} is not translated`);
      }
    }
  }
}

// ---------------------------------------------------------------------------

checkCatalogs();
checkLiterals();

if (problems.length > 0) {
  console.error(`i18n check: ${problems.length} problem(s)\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    "\nCatalogs live in src/locales/. The words a screen may print without t() are in scripts/i18n-allowlist.json.",
  );
  process.exit(1);
}

console.log("i18n check: catalogs and screens are clean");
