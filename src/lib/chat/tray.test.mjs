/**
 * Tests for src/lib/chat/tray.ts: the labels the tray and the core's
 * notifications get.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { SUMMARY_TOKENS, trayLabels } from "./tray.ts";

/** A stand-in `t` that interpolates `{{name}}` like i18next and names its key. */
function makeT(catalog) {
  return (key, options = {}) => {
    const plural = typeof options.count === "number" ? `${key}_${options.count === 1 ? "one" : "other"}` : key;
    const text = catalog[plural] ?? catalog[key];
    if (text === undefined) throw new Error(`no key ${key}`);
    return text.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name]));
  };
}

const EN = {
  "tray.open": "Open JKNet",
  "tray.chat": "Open chats",
  "tray.chatCount_one": "Open chats ({{count}})",
  "tray.chatCount_other": "Open chats ({{count}})",
  "tray.dnd": "Do not disturb",
  "tray.quit": "Quit",
  "tray.tooltip": "JKNet",
  "tray.tooltipUnread_one": "JKNet: {{count}} unread message",
  "tray.tooltipUnread_other": "JKNet: {{count}} unread messages",
  "tray.newMessage": "New message",
  "people.deleted": "Deleted account",
  "tray.summaryTitle": "Messages while you played",
  "tray.summary": "Messages: {{messages}}, chats: {{chats}}",
  "tray.hintTitle": "JKNet is still running",
  "tray.hint": "Closing the window keeps JKNet in the tray.",
};

describe("trayLabels", () => {
  test("without unread messages the menu and the tooltip carry no count", () => {
    const labels = trayLabels(makeT(EN), 0);
    assert.equal(labels.chat, "Open chats");
    assert.equal(labels.tooltip, "JKNet");
    assert.equal(labels.open, "Open JKNet");
    assert.equal(labels.dnd, "Do not disturb");
    assert.equal(labels.quit, "Quit");
  });

  test("unread messages go into Open chats and the tooltip", () => {
    const one = trayLabels(makeT(EN), 1);
    assert.equal(one.chat, "Open chats (1)");
    assert.equal(one.tooltip, "JKNet: 1 unread message");
    const many = trayLabels(makeT(EN), 12);
    assert.equal(many.chat, "Open chats (12)");
    assert.equal(many.tooltip, "JKNet: 12 unread messages");
  });

  test("a negative or fractional count is no count", () => {
    assert.equal(trayLabels(makeT(EN), -3).chat, "Open chats");
    assert.equal(trayLabels(makeT(EN), 2.7).chat, "Open chats (2)");
  });

  test("the summary keeps the core's own tokens for the counts", () => {
    const labels = trayLabels(makeT(EN), 0);
    assert.equal(labels.summary, "Messages: {messages}, chats: {chats}");
    assert.ok(labels.summary.includes(SUMMARY_TOKENS.messages));
    assert.ok(labels.summary.includes(SUMMARY_TOKENS.chats));
    // A language that turns the sentence around still carries both.
    const ru = trayLabels(makeT({ ...EN, "tray.summary": "Чатов: {{chats}}, сообщений: {{messages}}" }), 0);
    assert.equal(ru.summary, "Чатов: {chats}, сообщений: {messages}");
  });

  test("every word of the core's notifications is sent", () => {
    const labels = trayLabels(makeT(EN), 0);
    assert.equal(labels.newMessage, "New message");
    assert.equal(labels.deletedAccount, "Deleted account");
    assert.equal(labels.summaryTitle, "Messages while you played");
    assert.equal(labels.hintTitle, "JKNet is still running");
    assert.equal(labels.hint, "Closing the window keeps JKNet in the tray.");
    for (const [key, value] of Object.entries(labels)) {
      assert.equal(typeof value, "string", key);
      assert.notEqual(value.trim(), "", key);
    }
  });
});
