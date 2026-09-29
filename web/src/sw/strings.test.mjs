import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { pushStrings } from "../../scripts/build-sw.mjs";

test("the worker gets the push words of all eight languages", () => {
  const all = pushStrings();
  assert.deepEqual(Object.keys(all).sort(), ["de", "en", "es", "fr", "hu", "pl", "ru", "uk"]);
  const english = JSON.parse(readFileSync(new URL("../locales/en/web.json", import.meta.url), "utf8")).push;
  assert.deepEqual(all.en, english);
  assert.notEqual(all.ru.activity, english.activity);
});

test("the words the notifications read are all there", () => {
  const content = readFileSync(new URL("./content.ts", import.meta.url), "utf8");
  const declared = /export interface PushStrings \{([^}]*)\}/.exec(content)?.[1] ?? "";
  const names = [...declared.matchAll(/(\w+): string;/g)].map((match) => match[1]).sort();
  assert.ok(names.length > 5, "PushStrings lists its words");
  assert.deepEqual(Object.keys(pushStrings().en).sort(), names);
});
