import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { CHANGELOG_RELEASES, LATEST_CHANGELOG_RELEASE } from "./changelog.ts";

const LOCALES = join(import.meta.dirname, "..", "locales");

test("changelog starts with unreleased and keeps releases newest first", () => {
  assert.equal(CHANGELOG_RELEASES[0].key, "unreleased");
  assert.equal(CHANGELOG_RELEASES[0].version, null);
  assert.equal(CHANGELOG_RELEASES[0].date, null);
  assert.equal(LATEST_CHANGELOG_RELEASE, CHANGELOG_RELEASES[1]);

  const releases = CHANGELOG_RELEASES.slice(1);
  const versions = releases.map((release) => release.version);
  assert.equal(new Set(versions).size, versions.length);
  assert.deepEqual(
    versions,
    [...versions].sort((left, right) =>
      right.localeCompare(left, undefined, { numeric: true }),
    ),
  );

  for (const release of releases) {
    assert.match(release.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(release.items.length > 0);
  }

  const items = CHANGELOG_RELEASES.flatMap((release) => release.items);
  assert.equal(new Set(items).size, items.length);
});

test("every language carries every changelog item", () => {
  const languages = readdirSync(LOCALES);
  assert.deepEqual(languages.sort(), ["de", "en", "es", "fr", "hu", "pl", "ru", "uk"]);

  for (const language of languages) {
    const catalog = JSON.parse(
      readFileSync(join(LOCALES, language, "changelog.json"), "utf8"),
    );
    const registered = CHANGELOG_RELEASES.flatMap((release) => release.items)
      .map((key) => key.slice("entries.".length))
      .sort();
    assert.deepEqual(Object.keys(catalog.entries).sort(), registered, language);
    for (const release of CHANGELOG_RELEASES) {
      for (const key of release.items) {
        const item = key
          .split(".")
          .reduce((value, part) => value?.[part], catalog);
        assert.equal(
          typeof item === "string" && item.trim().length > 0,
          true,
          `${language}:${key}`,
        );
      }
    }
  }
});
