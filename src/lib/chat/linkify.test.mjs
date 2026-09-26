/**
 * Tests for src/lib/chat/linkify.ts: which runs of a message become links.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { hasLink, isTrustedLink, isWebUrl, linkHost, linkify, MAX_LINK_LENGTH } from "./linkify.ts";

describe("linkify", () => {
  test("plain text stays one segment", () => {
    assert.deepEqual(linkify("gg on ffa3"), [{ type: "text", text: "gg on ffa3" }]);
  });

  test("an empty text gives no segments", () => {
    assert.deepEqual(linkify(""), []);
  });

  test("an https link in the middle of a sentence", () => {
    assert.deepEqual(linkify("New hilt pack: https://jkhub.org/files/1 enjoy"), [
      { type: "text", text: "New hilt pack: " },
      { type: "link", text: "https://jkhub.org/files/1", href: "https://jkhub.org/files/1" },
      { type: "text", text: " enjoy" },
    ]);
  });

  test("the full stop and comma of the sentence are not part of the link", () => {
    const segments = linkify("See https://jknet.app/faq. Or https://jkhub.org, maybe.");
    assert.deepEqual(
      segments.filter((s) => s.type === "link").map((s) => s.href),
      ["https://jknet.app/faq", "https://jkhub.org"],
    );
  });

  test("a closing bracket the address opened is kept, the sentence's is not", () => {
    assert.equal(
      linkify("https://en.wikipedia.org/wiki/Jedi_(Star_Wars)")[0].href,
      "https://en.wikipedia.org/wiki/Jedi_(Star_Wars)",
    );
    const inBrackets = linkify("(see https://jkhub.org/files)");
    assert.deepEqual(inBrackets, [
      { type: "text", text: "(see " },
      { type: "link", text: "https://jkhub.org/files", href: "https://jkhub.org/files" },
      { type: "text", text: ")" },
    ]);
  });

  test("other schemes stay text", () => {
    for (const text of [
      "javascript:alert(1)",
      "file:///C:/Windows/system32",
      "steam://run/6020",
      "ftp://example.com/a",
      "data:text/html,<script>alert(1)</script>",
    ]) {
      assert.deepEqual(linkify(text), [{ type: "text", text }], text);
    }
  });

  test("markup around a link does not end up in it", () => {
    const segments = linkify('<a href="https://evil.example">x</a>');
    const links = segments.filter((s) => s.type === "link");
    assert.deepEqual(links.map((s) => s.href), ["https://evil.example"]);
    assert.equal(segments.map((s) => s.text).join(""), '<a href="https://evil.example">x</a>');
  });

  test("a bare scheme is not a link", () => {
    assert.deepEqual(linkify("type https:// then the host"), [
      { type: "text", text: "type https:// then the host" },
    ]);
  });

  test("an address longer than the core opens stays text", () => {
    const long = `https://example.com/${"a".repeat(MAX_LINK_LENGTH)}`;
    assert.deepEqual(linkify(long), [{ type: "text", text: long }]);
  });

  test("the scheme is found in any case", () => {
    assert.equal(linkify("HTTPS://JKNET.APP")[0].type, "link");
  });

  test("segments always join back into the original text", () => {
    const text = "a https://x.example/b?c=d#e, (https://y.example) and «https://z.example»!";
    assert.equal(linkify(text).map((s) => s.text).join(""), text);
  });

  test("hasLink", () => {
    assert.equal(hasLink("see https://jknet.app"), true);
    assert.equal(hasLink("see jknet.app"), false);
  });
});

describe("isWebUrl", () => {
  test("accepts http and https with a host only", () => {
    assert.equal(isWebUrl("https://jknet.app"), true);
    assert.equal(isWebUrl("http://203.0.113.5:8080/x"), true);
    assert.equal(isWebUrl("mailto:someone@example.com"), false);
    assert.equal(isWebUrl("not a url"), false);
  });
});

describe("isTrustedLink", () => {
  test("jknet.app, jkhub.org and their subdomains", () => {
    assert.equal(isTrustedLink("https://jknet.app/download"), true);
    assert.equal(isTrustedLink("https://www.jkhub.org/files/1"), true);
    assert.equal(isTrustedLink("https://api.jknet.app"), true);
  });

  test("look-alike hosts are not trusted", () => {
    assert.equal(isTrustedLink("https://jknet.app.evil.example"), false);
    assert.equal(isTrustedLink("https://notjkhub.org"), false);
    assert.equal(isTrustedLink("https://jkhub.org@evil.example"), false);
    assert.equal(isTrustedLink("javascript:alert(1)"), false);
  });

  test("linkHost drops www", () => {
    assert.equal(linkHost("https://www.Example.com/a"), "example.com");
  });
});
