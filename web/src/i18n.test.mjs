import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { catalogPath, englishResources, loadCatalogs, WEB_NAMESPACES } from "./i18nCatalogs.ts";

const LANGUAGES = ["en", "ru", "uk", "de", "fr", "es", "pl", "hu"];
const LAUNCHER_ONLY = ["nav", "home", "settings", "onboarding", "update"];

/** A glob result with every namespace the launcher has, the excluded ones too. */
function everyCatalog(language) {
  const map = {};
  for (const namespace of [...WEB_NAMESPACES, ...LAUNCHER_ONLY]) {
    const path = namespace === "web" ? `./locales/${language}/web.json` : `../../src/locales/${language}/${namespace}.json`;
    map[path] = { marker: `${language}/${namespace}` };
  }
  return map;
}

test("English carries the web's namespaces and nothing else", () => {
  const resources = englishResources(everyCatalog("en"));
  assert.deepEqual(Object.keys(resources).sort(), [...WEB_NAMESPACES].sort());
  for (const namespace of LAUNCHER_ONLY) assert.equal(resources[namespace], undefined, namespace);
});

test("a language loads only its own files of the web's namespaces", async () => {
  const asked = [];
  const lazy = {};
  for (const language of LANGUAGES) {
    for (const [path, catalog] of Object.entries(everyCatalog(language))) {
      lazy[path] = async () => {
        asked.push(path);
        return catalog;
      };
    }
  }
  const files = await loadCatalogs("ru", lazy);
  assert.deepEqual(files.map((file) => file.namespace).sort(), [...WEB_NAMESPACES].sort());
  assert.ok(asked.every((path) => path.includes("/ru/")), "only Russian was fetched");
  assert.equal(asked.length, WEB_NAMESPACES.length);
  assert.ok(!asked.some((path) => LAUNCHER_ONLY.some((ns) => path.endsWith(`/${ns}.json`))));
});

test("a file that fails to load is left to the English fallback", async () => {
  const lazy = {
    [catalogPath("de", "chat")]: async () => {
      throw new Error("offline");
    },
    [catalogPath("de", "web")]: async () => ({ ok: true }),
  };
  const original = console.warn;
  console.warn = () => {};
  try {
    const files = await loadCatalogs("de", lazy);
    assert.deepEqual(files, [{ namespace: "web", catalog: { ok: true } }]);
  } finally {
    console.warn = original;
  }
});

test("the literal globs of i18n.ts name exactly the web's namespaces", () => {
  const source = readFileSync(new URL("./i18n.ts", import.meta.url), "utf8");
  const english = [...source.matchAll(/"\.\.\/\.\.\/src\/locales\/en\/([a-z0-9]+)\.json"/g)].map((match) => match[1]);
  const translated = [...source.matchAll(/"\.\.\/\.\.\/src\/locales\/\*\/([a-z0-9]+)\.json"/g)].map((match) => match[1]);
  const shared = WEB_NAMESPACES.filter((namespace) => namespace !== "web");
  assert.deepEqual(english.sort(), [...shared].sort());
  assert.deepEqual(translated.sort(), [...shared].sort());
  assert.ok(source.includes('"./locales/en/web.json"'));
  assert.ok(source.includes('"./locales/*/web.json"'));
  assert.ok(!/from\s+"[^"]*src\/i18n(\/index(\.ts)?)?"/.test(source), "the launcher's loader is not imported");
});

test("every namespace of the list has a catalog in every language", () => {
  for (const language of LANGUAGES) {
    for (const namespace of WEB_NAMESPACES) {
      const url = new URL(catalogPath(language, namespace), import.meta.url);
      assert.ok(existsSync(url), `${language}/${namespace}.json`);
    }
  }
});
