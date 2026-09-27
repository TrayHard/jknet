#!/usr/bin/env node
/**
 * Writes `<out>/version.json`: the commit and time of the build and the
 * oldest build the site still accepts.
 *
 * The app fetches it at start and every 30 minutes; a `minBuiltAt` newer than
 * its own build time puts it on a blocking **Update** screen. Raise
 * `minBuiltAt` in `web/version-policy.json` when a change of the service
 * breaks older builds.
 *
 * Usage: `node web/scripts/write-version.mjs [--out DIR]`, `DIR` defaulting to
 * `web/dist`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const at = process.argv.indexOf("--out");
const out = resolve(at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : join(WEB, "dist"));

const info = JSON.parse(readFileSync(join(out, ".vite", "build.json"), "utf8"));
const policy = JSON.parse(readFileSync(join(WEB, "version-policy.json"), "utf8"));
const minBuiltAt = typeof policy.minBuiltAt === "string" ? policy.minBuiltAt : null;

const version = { commit: info.commit, builtAt: info.builtAt, minBuiltAt };
writeFileSync(join(out, "version.json"), `${JSON.stringify(version, null, 2)}\n`);
console.log(`version.json: ${version.commit}, built ${version.builtAt}`);
