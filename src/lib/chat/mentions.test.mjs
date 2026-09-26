/**
 * Tests for src/lib/chat/mentions.ts: mention tokens in, out and while typing.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  decodeMentions,
  encodeMentions,
  insertMention,
  mentionedIds,
  mentionQueryAt,
  plainText,
  splitMentions,
} from "./mentions.ts";

const KAI = "01K5KAI000000000000000000A";
const DANA = "01K5DANA00000000000000000B";

describe("splitMentions", () => {
  test("text without tokens is one segment", () => {
    assert.deepEqual(splitMentions("gg"), [{ type: "text", text: "gg" }]);
  });

  test("tokens between text", () => {
    assert.deepEqual(splitMentions(`gg <@${KAI}> and <@${DANA}>!`), [
      { type: "text", text: "gg " },
      { type: "mention", userId: KAI },
      { type: "text", text: " and " },
      { type: "mention", userId: DANA },
      { type: "text", text: "!" },
    ]);
  });

  test("<@deleted> is a mention of nobody", () => {
    assert.deepEqual(splitMentions("thanks <@deleted>"), [
      { type: "text", text: "thanks " },
      { type: "mention", userId: null },
    ]);
  });

  test("something that only looks like a token stays text", () => {
    for (const text of ["<@short>", "<@ 01K5KAI000000000000000000A>", "<script>", "<@>"]) {
      assert.deepEqual(splitMentions(text), [{ type: "text", text }], text);
    }
  });

  test("mentionedIds lists each id once and leaves deleted out", () => {
    assert.deepEqual(mentionedIds(`<@${KAI}> <@deleted> <@${KAI}> <@${DANA}>`), [KAI, DANA]);
  });
});

describe("encodeMentions", () => {
  test("a picked name becomes its token", () => {
    assert.equal(
      encodeMentions("@Kai you're seeded first", [{ id: KAI, name: "Kai" }]),
      `<@${KAI}> you're seeded first`,
    );
  });

  test("the longer name wins", () => {
    const picks = [
      { id: DANA, name: "Kai" },
      { id: KAI, name: "Kai Katarn" },
    ];
    assert.equal(encodeMentions("@Kai Katarn and @Kai", picks), `<@${KAI}> and <@${DANA}>`);
  });

  test("a name inside a longer word is left alone", () => {
    assert.equal(encodeMentions("@Kaiden, mail kai@Kai.example", [{ id: KAI, name: "Kai" }]), "@Kaiden, mail kai@Kai.example");
  });

  test("punctuation after the name ends it", () => {
    assert.equal(encodeMentions("@Kai, go", [{ id: KAI, name: "Kai" }]), `<@${KAI}>, go`);
  });

  test("names with spaces and Cyrillic", () => {
    const picks = [{ id: DANA, name: "Дана Р" }];
    assert.equal(encodeMentions("привет @Дана Р!", picks), `привет <@${DANA}>!`);
  });

  test("no picks: the text as it is", () => {
    assert.equal(encodeMentions("@Kai hi", []), "@Kai hi");
  });
});

describe("decodeMentions", () => {
  test("round trip with encodeMentions", () => {
    const names = { [KAI]: "Kai", [DANA]: "Dana" };
    const body = `<@${KAI}> vs <@${DANA}> tonight`;
    const decoded = decodeMentions(body, (id) => names[id] ?? null, "Deleted account");
    assert.equal(decoded.text, "@Kai vs @Dana tonight");
    assert.equal(encodeMentions(decoded.text, decoded.picks), body);
  });

  test("an unknown id and a deleted account become plain text", () => {
    const decoded = decodeMentions(`<@${KAI}> <@deleted>`, () => null, "Deleted account");
    assert.equal(decoded.text, "@Deleted account @Deleted account");
    assert.deepEqual(decoded.picks, []);
  });
});

describe("mentionQueryAt", () => {
  test("an @ at the start", () => {
    assert.deepEqual(mentionQueryAt("@Ka", 3), { start: 0, query: "Ka" });
  });

  test("an @ after a space, and an empty query right after typing it", () => {
    assert.deepEqual(mentionQueryAt("gg @", 4), { start: 3, query: "" });
  });

  test("an e-mail address opens nothing", () => {
    assert.equal(mentionQueryAt("mail@host", 9), null);
  });

  test("a finished mention followed by a space opens nothing", () => {
    assert.equal(mentionQueryAt("@Kai ", 5), null);
  });

  test("the caret decides, not the end of the text", () => {
    assert.deepEqual(mentionQueryAt("@Da and more", 3), { start: 0, query: "Da" });
  });

  test("insertMention puts the name and a space and moves the caret", () => {
    const text = "hi @Da there";
    const query = mentionQueryAt(text, 6);
    assert.deepEqual(insertMention(text, query, 6, "Dana"), { text: "hi @Dana  there", caret: 9 });
  });
});

describe("plainText", () => {
  test("tokens become names, white space collapses", () => {
    const nameOf = (id) => (id === KAI ? "Kai" : "Deleted account");
    assert.equal(plainText(`<@${KAI}>\n\n  gg   <@deleted>`, nameOf), "@Kai gg @Deleted account");
  });

  test("a long text is cut with an ellipsis", () => {
    const out = plainText("a".repeat(300), () => "", 10);
    assert.equal(out, `${"a".repeat(9)}…`);
  });
});
