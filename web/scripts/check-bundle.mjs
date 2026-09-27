#!/usr/bin/env node
/**
 * Fails a web build that grew too heavy or pulled in what the launcher alone
 * needs.
 *
 * 1. Budget: the entry chunk and every chunk it imports statically — what a
 *    phone downloads before the first screen — at most 400 KB gzipped.
 * 2. Bans: no output chunk may contain Three.js, CodeMirror or TipTap (the
 *    launcher's previews and editors), the launcher's i18n loader
 *    `src/i18n/index.ts`, or a catalog of `src/locales/` whose namespace the
 *    web app does not read.
 *
 * Reads `<out>/.vite/manifest.json` and `<out>/.vite/modules.json`, which the
 * `jknet-module-map` plugin of `web/vite.config.ts` writes.
 *
 * Usage: `node web/scripts/check-bundle.mjs [--out DIR]`, `DIR` defaulting to
 * `web/dist`.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { WEB_NAMESPACES } from "../src/i18nCatalogs.ts";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const at = process.argv.indexOf("--out");
const out = resolve(at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : join(WEB, "dist"));

/** The budget of the first download, gzipped. */
export const BUDGET_BYTES = 400 * 1024;

const BANNED_PACKAGES = /node_modules\/(three|@codemirror|@tiptap)\//;
const LAUNCHER_LOADER = /(^|\/)src\/i18n\/index\.ts$/;
const CATALOG = /(^|\/)src\/locales\/[^/]+\/([^/]+)\.json$/;

const manifest = JSON.parse(readFileSync(join(out, ".vite", "manifest.json"), "utf8"));
const modules = JSON.parse(readFileSync(join(out, ".vite", "modules.json"), "utf8"));
const problems = [];

// -- Budget -------------------------------------------------------------------

const entry = Object.values(manifest).find((chunk) => chunk.isEntry);
if (entry === undefined) {
  problems.push("the Vite manifest has no entry chunk");
} else {
  const files = new Set();
  const walk = (chunk) => {
    if (chunk === undefined || files.has(chunk.file)) return;
    files.add(chunk.file);
    for (const key of chunk.imports ?? []) walk(manifest[key]);
  };
  walk(entry);
  let total = 0;
  const sizes = [];
  for (const file of files) {
    const size = gzipSync(readFileSync(join(out, file))).length;
    total += size;
    sizes.push(`${file} ${(size / 1024).toFixed(1)} KB`);
  }
  console.log(`first download: ${(total / 1024).toFixed(1)} KB gzipped in ${files.size} chunks (budget ${BUDGET_BYTES / 1024} KB)`);
  for (const line of sizes) console.log(`  ${line}`);
  if (total > BUDGET_BYTES) {
    problems.push(`the first download is ${(total / 1024).toFixed(1)} KB gzipped, over the ${BUDGET_BYTES / 1024} KB budget`);
  }
}

// -- Bans ---------------------------------------------------------------------

const allowed = new Set(WEB_NAMESPACES);
for (const [chunk, ids] of Object.entries(modules)) {
  for (const id of ids) {
    if (BANNED_PACKAGES.test(id)) problems.push(`${chunk}: ${id} is a launcher-only package`);
    if (LAUNCHER_LOADER.test(id)) problems.push(`${chunk}: ${id} is the launcher's i18n loader`);
    const catalog = CATALOG.exec(id);
    if (catalog !== null && !allowed.has(catalog[2])) {
      problems.push(`${chunk}: ${id} is a catalog the web app does not read`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`check-bundle: ${problem}`);
  process.exit(1);
}
console.log(`check-bundle: ${Object.keys(modules).length} chunks, no banned module`);
