#!/usr/bin/env node
/**
 * Builds the service worker next to a finished web build.
 *
 * `web/src/sw/sw.ts` becomes one classic script, `<out>/sw.js`, with four
 * constants baked in: `__PRECACHE__`, the shell of this build;
 * `__BUILD__`, the name of its cache; `__PUSH_STRINGS__`, the `push` section
 * of every language's `web.json`, the words of notifications; and
 * `__E2E__`, true in the build of the e2e run (mode `e2e`), whose worker
 * records notifications instead of showing them. The shell is the page, the entry chunk
 * with its static imports and their styles, the WOFF2 fonts those styles
 * use, the manifest, the icons and the chat sounds: everything the app
 * needs to open offline. Chunks of later routes are cached on their first
 * load.
 *
 * Usage: `node web/scripts/build-sw.mjs [--out DIR]`, `DIR` defaulting to
 * `web/dist`, from the repository root.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function outDir() {
  const at = process.argv.indexOf("--out");
  return resolve(at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : join(WEB, "dist"));
}

/** The entry chunk and every chunk it imports statically, with their styles and assets. */
export function shellFiles(manifest) {
  const entry = Object.values(manifest).find((chunk) => chunk.isEntry);
  if (entry === undefined) throw new Error("the Vite manifest has no entry chunk");
  const files = new Set();
  const seen = new Set();
  const walk = (chunk) => {
    if (chunk === undefined || seen.has(chunk.file)) return;
    seen.add(chunk.file);
    files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const asset of chunk.assets ?? []) files.add(asset);
    for (const key of chunk.imports ?? []) walk(manifest[key]);
  };
  walk(entry);
  return [...files];
}

/** The fonts a style sheet references, WOFF2 only: every browser with a service worker reads it. */
function fontsOf(out, cssFiles) {
  const fonts = new Set();
  for (const css of cssFiles) {
    const text = readFileSync(join(out, css), "utf8");
    for (const match of text.matchAll(/url\(\s*["']?(\/?assets\/[^"')]+\.woff2)["']?\s*\)/g)) {
      fonts.add(match[1].replace(/^\//, ""));
    }
  }
  return [...fonts];
}

/** `{ "<lang>": { <push section of web.json> } }` for every language folder. */
export function pushStrings(localesDir = join(WEB, "src", "locales")) {
  const all = {};
  for (const entry of readdirSync(localesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(localesDir, entry.name, "web.json");
    if (!existsSync(file)) continue;
    const push = JSON.parse(readFileSync(file, "utf8")).push;
    if (push !== null && typeof push === "object") all[entry.name] = push;
  }
  if (all.en === undefined) throw new Error("web/src/locales/en/web.json has no push section");
  return all;
}

function publicFiles(folder) {
  const dir = join(WEB, "public", folder);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .map((name) => `/${folder}/${name}`);
}

async function main() {
  const out = outDir();
  const manifest = JSON.parse(readFileSync(join(out, ".vite", "manifest.json"), "utf8"));
  const info = JSON.parse(readFileSync(join(out, ".vite", "build.json"), "utf8"));

  const files = shellFiles(manifest);
  const css = files.filter((file) => file.endsWith(".css"));
  const shell = [
    "/",
    "/index.html",
    ...files.filter((file) => !/\.(woff2?|ttf|otf)$/.test(file)).map((file) => `/${file}`),
    ...fontsOf(out, css).map((file) => `/${file}`),
    "/manifest.webmanifest",
    ...publicFiles("icons"),
    ...publicFiles("sounds"),
    "/brand/jknet-logo-64.png",
    "/brand/jknet-logo-128.png",
  ];
  const unique = [...new Set(shell)];
  const buildId = `${info.commit}-${Date.parse(info.builtAt).toString(36)}`;

  await build({
    configFile: false,
    publicDir: false,
    logLevel: "warn",
    define: {
      // A string holding JSON: an array literal in `define` is flattened
      // into one string by the bundler.
      __PRECACHE__: JSON.stringify(JSON.stringify(unique)),
      __BUILD__: JSON.stringify(buildId),
      __PUSH_STRINGS__: JSON.stringify(JSON.stringify(pushStrings())),
      __E2E__: JSON.stringify(info.mode === "e2e"),
    },
    build: {
      outDir: out,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: true,
      sourcemap: false,
      lib: {
        entry: join(WEB, "src", "sw", "sw.ts"),
        formats: ["iife"],
        name: "jknetServiceWorker",
        fileName: () => "sw.js",
      },
    },
  });
  console.log(`sw.js: ${unique.length} files in the shell of build ${buildId}${info.mode === "e2e" ? " (e2e: notifications recorded)" : ""}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
