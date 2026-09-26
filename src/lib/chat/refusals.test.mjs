/**
 * Tests that every refusal reason the chat API sends has words in the English
 * catalogs; `npm run i18n:check` then holds the other languages to the same
 * keys.
 *
 * The lists mirror `details.reason` of the service's chat routes and the
 * `reason` of a player a group change left out. A reason missing here reads
 * as its raw code in the outbox and as the English sentence of the service
 * elsewhere.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

function catalog(namespace) {
  return JSON.parse(readFileSync(new URL(`../../locales/en/${namespace}.json`, import.meta.url), "utf8"));
}

/** `too_many_groups` as the catalogs spell it: `tooManyGroups`. */
function camel(reason) {
  return reason.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/** `details.reason` of a refusal of `/v1/chat/*`. */
const SERVICE_REASONS = [
  "card",
  "emoji",
  "empty",
  "file_gone",
  "file_not_ready",
  "file_too_large",
  "files",
  "group_full",
  "hash_mismatch",
  "invalid",
  "not_friends",
  "not_hosting",
  "owner_only",
  "quota_account",
  "quota_store",
  "reactions",
  "size_mismatch",
  "too_long",
  "too_many_groups",
];

/** `refused[].reason` of the answer to a group create or add. */
const MEMBER_REASONS = ["cooldown", "full", "member", "not_friend", "too_many_groups"];

describe("chat refusal texts", () => {
  const errors = catalog("errors");
  const chat = catalog("chat");

  test("a refused command has a sentence under errors:online", () => {
    const missing = SERVICE_REASONS.filter((reason) => typeof errors.online[camel(reason)] !== "string");
    assert.deepEqual(missing, []);
  });

  test("a failed send has a reason under chat:outbox.reasons", () => {
    const missing = SERVICE_REASONS.filter((reason) => typeof chat.outbox.reasons[camel(reason)] !== "string");
    assert.deepEqual(missing, []);
  });

  test("a player left out of a group has a line under chat:group.report", () => {
    const missing = MEMBER_REASONS.filter((reason) => typeof chat.group.report[camel(reason)] !== "string");
    assert.deepEqual(missing, []);
  });
});
