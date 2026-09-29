/**
 * The Content-Security-Policy of the web app (`vite.config.ts`, the headers
 * `vite preview` serves and the hosting copies) against the hosts the shared
 * code loads from: a picture from an unlisted host is blocked silently.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { youtubeEmbed, youtubeThumbnail } from "../../src/lib/videoLinks.ts";

const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");

function sources(directive) {
  const line = config.split("\n").find((entry) => entry.includes(`${directive} `));
  assert.ok(line, `${directive} is in the policy`);
  return line.replace(/^[\s"`]*/, "").replace(/[",`]*\s*$/, "").split(/\s+/).slice(1);
}

test("the still of a YouTube video comes from a host img-src lists", () => {
  assert.ok(sources("img-src").includes(new URL(youtubeThumbnail("dQw4w9WgXcQ")).origin));
});

test("the player of a YouTube video comes from a host frame-src lists", () => {
  assert.ok(sources("frame-src").includes(new URL(youtubeEmbed("dQw4w9WgXcQ")).origin));
});
