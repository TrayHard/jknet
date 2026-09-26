/**
 * Tests for src/lib/chat/dangers.ts: the dangers of a bind or a config card.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { dangerPath, dangerReasonKey, dangersByLine, scanIncomplete } from "./dangers.ts";

describe("dangerReasonKey", () => {
  test("snake_case reasons of the core become catalog keys", () => {
    assert.equal(dangerReasonKey("quit"), "quit");
    assert.equal(dangerReasonKey("write_config"), "writeConfig");
    assert.equal(dangerReasonKey("allow_download"), "allowDownload");
    assert.equal(dangerReasonKey("nested_bind"), "nestedBind");
    assert.equal(dangerReasonKey("too_complex"), "tooComplex");
  });

  test("a reason this launcher does not know reads as other", () => {
    assert.equal(dangerReasonKey("format_disk"), "other");
    assert.equal(dangerReasonKey(""), "other");
  });
});

describe("dangersByLine", () => {
  test("groups by line, lines ascending, order within a line kept", () => {
    const dangers = [
      { line: 3, command: "exec other", reason: "exec", via: [] },
      { line: 1, command: "quit", reason: "quit", via: ["bind F"] },
      { line: 3, command: "cl_allowDownload 1", reason: "allow_download", via: [] },
    ];
    assert.deepEqual(
      dangersByLine(dangers).map((entry) => [entry.line, entry.dangers.map((d) => d.reason)]),
      [
        [1, ["quit"]],
        [3, ["exec", "allow_download"]],
      ],
    );
  });

  test("no dangers, no lines", () => {
    assert.deepEqual(dangersByLine([]), []);
  });
});

describe("scanIncomplete and dangerPath", () => {
  test("too_complex marks a scan that stopped early", () => {
    assert.equal(scanIncomplete([{ line: 1, command: "vstr a", reason: "too_complex" }]), true);
    assert.equal(scanIncomplete([{ line: 1, command: "quit", reason: "quit" }]), false);
  });

  test("the path runs from the key press to the command", () => {
    assert.equal(dangerPath({ line: 1, command: "quit", reason: "quit", via: ["bind F", "vstr e2"] }), "bind F → vstr e2 → quit");
    assert.equal(dangerPath({ line: 2, command: "unbindall", reason: "unbind_all" }), "unbindall");
  });
});
