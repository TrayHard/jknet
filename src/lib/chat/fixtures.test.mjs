/**
 * Tests for src/lib/chat/fixtures/: the rule cases the launcher's core and
 * the web app's core share.
 *
 * The Rust tests of `src-tauri/src/chat/{links,outbox,notify,frames}.rs` run
 * every case against the launcher's rules; the web app's core runs the same
 * files against its port. What is checked here is what both sides rely on:
 * that each file has the shape its readers expect, and, for the links, that
 * the browser's URL parser writes an address back exactly as the core's does
 * and that the thread's `isTrustedLink` agrees with the core about which
 * addresses open without asking.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { isTrustedLink } from "./linkify.ts";

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

const links = fixture("links.json");
const failures = fixture("outbox-failures.json");
const notify = fixture("notify-decide.json");
const frames = fixture("frames.json");

describe("links.json", () => {
  test("every case has an input and one of the three verdicts", () => {
    assert.ok(links.length >= 30);
    for (const entry of links) {
      assert.equal(typeof entry.input, "string");
      assert.ok(["open", "confirm", "refuse"].includes(entry.verdict), JSON.stringify(entry));
      if (entry.verdict === "refuse") assert.equal(entry.url, undefined, entry.input);
    }
    for (const verdict of ["open", "confirm", "refuse"]) {
      assert.ok(links.some((entry) => entry.verdict === verdict), verdict);
    }
  });

  test("the browser writes an address back as the core does", () => {
    for (const entry of links.filter((one) => one.url !== undefined)) {
      assert.equal(new URL(entry.input).href, entry.url, entry.input);
    }
  });

  test("the thread trusts exactly the addresses the core opens at once", () => {
    for (const entry of links.filter((one) => one.verdict !== "refuse")) {
      assert.equal(isTrustedLink(entry.input), entry.verdict === "open", entry.input);
    }
  });
});

describe("outbox-failures.json", () => {
  test("every case is an answer and one of the three rows", () => {
    assert.ok(failures.length >= 10);
    for (const entry of failures) {
      assert.ok(Number.isInteger(entry.status) && entry.status >= 0 && entry.status < 600, JSON.stringify(entry));
      assert.ok(entry.code === null || typeof entry.code === "string", JSON.stringify(entry));
      assert.ok(["retry", "reregister", "fail"].includes(entry.verdict), JSON.stringify(entry));
    }
    // The network, a lost file and a refusal are each there.
    assert.ok(failures.some((entry) => entry.status === 0 && entry.verdict === "retry"));
    assert.ok(failures.some((entry) => entry.verdict === "reregister"));
    assert.ok(failures.some((entry) => entry.verdict === "fail"));
  });
});

describe("notify-decide.json", () => {
  test("every case names itself and expects one delivery", () => {
    const names = new Set();
    for (const entry of notify) {
      assert.ok(!names.has(entry.name), `${entry.name} twice`);
      names.add(entry.name);
      // A level a newer service sends notifies like `all`, so any string goes.
      assert.equal(typeof entry.notify, "string", entry.name);
      assert.match(entry.context.time, /^\d{2}:\d{2}$/, entry.name);
      assert.equal(typeof entry.context.focused, "boolean", entry.name);
      assert.ok(["silent", "toast", "sound", "summary"].includes(entry.expect), entry.name);
    }
  });

  test("what only a launcher knows is marked so the web app skips it", () => {
    for (const entry of notify) {
      const launcherOnly =
        entry.expect === "summary" || entry.context.inGame === true || entry.context.otherWindowFocused === true;
      assert.equal(entry.launcherOnly === true, launcherOnly, entry.name);
    }
    assert.ok(notify.filter((entry) => !entry.launcherOnly).length >= 20);
  });
});

describe("frames.json", () => {
  const KINDS = new Set([
    "chat:message",
    "chat:read",
    "chat:typing",
    "chat:reaction",
    "chat:removed",
    "state",
    "outbox",
    "markRead",
    "refresh",
    "resync",
    "typingExpires",
    "notify",
  ]);

  test("every case is a state, one frame and effects of known kinds", () => {
    const names = new Set();
    for (const entry of frames) {
      assert.ok(!names.has(entry.name), `${entry.name} twice`);
      names.add(entry.name);
      assert.equal(typeof entry.frame.type, "string", entry.name);
      assert.ok(entry.frame.payload !== null && typeof entry.frame.payload === "object", entry.name);
      for (const effect of entry.effects) assert.ok(KINDS.has(effect), `${entry.name}: ${effect}`);
    }
  });

  test("every frame kind of the contract has a case", () => {
    const kinds = new Set(frames.map((entry) => entry.frame.type));
    for (const kind of [
      "chat.message",
      "chat.read",
      "chat.typing",
      "chat.reaction",
      "chat.conversation",
      "chat.conversation.removed",
      "chat.groupInvite",
      "chat.groupInvite.removed",
      "chat.settings",
      "chat.resync",
    ]) {
      assert.ok(kinds.has(kind), kind);
    }
  });
});
