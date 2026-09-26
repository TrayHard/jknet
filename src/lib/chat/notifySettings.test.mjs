/**
 * Tests for src/lib/chat/notifySettings.ts: defaults, the clock of quiet
 * hours, the optimistic patch and the chats with their own level.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  applyChatPatch,
  autoDownloadOf,
  autoDownloadOptions,
  CHAT_SOUNDS,
  chatNotificationsOf,
  chatOpenInOf,
  clockLabel,
  closeToTrayOf,
  DEFAULT_CHAT_NOTIFICATIONS,
  formatClock,
  isChatSound,
  isQuietAt,
  minutesOfDay,
  mutedChats,
  normalizeClock,
  parseClock,
  quietHoursShape,
  silenceAt,
  startMinimizedOf,
} from "./notifySettings.ts";

/** A settings document with only the fields a test names. */
function settings(fields = {}) {
  return { activeGame: "ja", language: "en", ...fields };
}

function conversation(id, notify, title = id) {
  return {
    id,
    kind: "group",
    title,
    ownerId: null,
    members: [],
    lastSeq: 0,
    lastMessage: null,
    readSeq: 0,
    visibleFromSeq: 0,
    unread: 0,
    unreadMentions: 0,
    notify,
    canSend: true,
    historyForNewMembers: false,
    server: null,
    createdAt: "2026-09-20T00:00:00Z",
  };
}

const at = (hours, minutes = 0) => hours * 60 + minutes;

describe("defaults", () => {
  test("a fresh launcher notifies everywhere and keeps quiet hours and DND off", () => {
    assert.deepEqual(DEFAULT_CHAT_NOTIFICATIONS, {
      inApp: true,
      os: true,
      sound: true,
      soundName: "default",
      showText: true,
      dnd: false,
      mentionsBreakDnd: false,
      dndInGame: true,
      summaryAfterGame: true,
      quietHours: null,
    });
  });

  test("a document of an older core reads as the defaults", () => {
    const empty = settings();
    assert.deepEqual(chatNotificationsOf(empty), DEFAULT_CHAT_NOTIFICATIONS);
    assert.deepEqual(chatNotificationsOf(undefined), DEFAULT_CHAT_NOTIFICATIONS);
    assert.equal(closeToTrayOf(empty), true, "the close button hides into the tray (D6)");
    assert.equal(startMinimizedOf(empty), true);
    assert.equal(chatOpenInOf(empty), "main");
    assert.equal(autoDownloadOf(empty), 10);
  });

  test("a partial block keeps what it has and fills the rest", () => {
    const read = chatNotificationsOf(settings({ chatNotifications: { dnd: true, soundName: "saber" } }));
    assert.deepEqual(read, { ...DEFAULT_CHAT_NOTIFICATIONS, dnd: true, soundName: "saber" });
  });

  test("a sound this build does not ship reads as the default one", () => {
    const read = chatNotificationsOf(
      settings({ chatNotifications: { ...DEFAULT_CHAT_NOTIFICATIONS, soundName: "wookiee" } }),
    );
    assert.equal(read.soundName, "default");
    assert.ok(CHAT_SOUNDS.every(isChatSound));
    assert.equal(isChatSound("wookiee"), false);
    assert.equal(isChatSound(3), false);
  });

  test("an unknown place to open chats reads as the launcher window", () => {
    assert.equal(chatOpenInOf(settings({ chatOpenIn: "window" })), "window");
    assert.equal(chatOpenInOf(settings({ chatOpenIn: "elsewhere" })), "main");
    assert.equal(closeToTrayOf(settings({ closeToTray: false })), false);
    assert.equal(startMinimizedOf(settings({ startMinimized: false })), false);
  });
});

describe("autoDownload", () => {
  test("the threshold stays within 0 and 25 MiB", () => {
    assert.equal(autoDownloadOf(settings({ chatAutoDownloadMb: 0 })), 0);
    assert.equal(autoDownloadOf(settings({ chatAutoDownloadMb: 25 })), 25);
    assert.equal(autoDownloadOf(settings({ chatAutoDownloadMb: 400 })), 25);
    assert.equal(autoDownloadOf(settings({ chatAutoDownloadMb: -1 })), 10);
  });

  test("a value written by hand is listed among the steps", () => {
    assert.deepEqual(autoDownloadOptions(10), [0, 1, 5, 10, 25]);
    assert.deepEqual(autoDownloadOptions(3), [0, 1, 3, 5, 10, 25]);
  });
});

describe("the clock", () => {
  test("H:MM and HH:MM read as minutes of the day, as in the core", () => {
    assert.equal(parseClock("00:00"), 0);
    assert.equal(parseClock("8:30"), at(8, 30));
    assert.equal(parseClock(" 23:59 "), at(23, 59));
    for (const bad of ["", "24:00", "12:60", "12", "12:5", "123:00", "ab:cd", "+1:00", "12:00:00", "-1:00"]) {
      assert.equal(parseClock(bad), null, bad);
    }
  });

  test("a time is stored with two digits for the hour", () => {
    assert.equal(formatClock(65), "01:05");
    assert.equal(formatClock(at(23, 0)), "23:00");
    assert.equal(normalizeClock("9:05"), "09:05");
    assert.equal(normalizeClock("9:5"), null);
  });

  test("a stored time is written the way the language on screen writes it", () => {
    assert.equal(clockLabel("08:00", "ru"), "08:00");
    assert.equal(clockLabel("23:30", "de"), "23:30");
    assert.match(clockLabel("08:00", "en-US"), /^8:00\sAM$/);
    assert.equal(clockLabel("oops", "en"), "oops");
  });

  test("a range is empty, within a day, across midnight or not a range", () => {
    assert.equal(quietHoursShape({ from: "23:00", to: "08:00" }), "overnight");
    assert.equal(quietHoursShape({ from: "13:00", to: "15:30" }), "sameDay");
    assert.equal(quietHoursShape({ from: "07:00", to: "07:00" }), "empty");
    assert.equal(quietHoursShape({ from: "07:00", to: "oops" }), "invalid");
  });

  test("quiet hours across midnight hold from the start up to the end", () => {
    const night = { from: "23:00", to: "08:00" };
    assert.equal(isQuietAt(night, at(22, 59)), false);
    assert.equal(isQuietAt(night, at(23, 0)), true);
    assert.equal(isQuietAt(night, at(0, 0)), true);
    assert.equal(isQuietAt(night, at(7, 59)), true);
    assert.equal(isQuietAt(night, at(8, 0)), false);
  });

  test("quiet hours within a day, equal ends and none", () => {
    const lunch = { from: "13:00", to: "14:00" };
    assert.equal(isQuietAt(lunch, at(12, 59)), false);
    assert.equal(isQuietAt(lunch, at(13, 30)), true);
    assert.equal(isQuietAt(lunch, at(14, 0)), false);
    assert.equal(isQuietAt({ from: "07:00", to: "07:00" }, at(7, 0)), false, "equal ends are never quiet");
    assert.equal(isQuietAt(null, at(3, 0)), false);
    assert.equal(isQuietAt({ from: "bad", to: "08:00" }, at(3, 0)), false);
  });

  test("the minutes of a local date", () => {
    assert.equal(minutesOfDay(new Date(2026, 8, 26, 21, 45)), at(21, 45));
  });

  test("silence names the switch, the clock or both", () => {
    const night = { from: "23:00", to: "08:00" };
    const base = { ...DEFAULT_CHAT_NOTIFICATIONS };
    assert.equal(silenceAt(base, at(12)), "none");
    assert.equal(silenceAt({ ...base, dnd: true }, at(12)), "dnd");
    assert.equal(silenceAt({ ...base, quietHours: night }, at(1)), "quiet");
    assert.equal(silenceAt({ ...base, quietHours: night }, at(12)), "none");
    assert.equal(silenceAt({ ...base, dnd: true, quietHours: night }, at(1)), "both");
  });
});

describe("applyChatPatch", () => {
  test("the notification block merges one switch at a time", () => {
    const before = settings({ chatNotifications: { ...DEFAULT_CHAT_NOTIFICATIONS, sound: false } });
    const after = applyChatPatch(before, { chatNotifications: { dnd: true } });
    assert.deepEqual(after.chatNotifications, { ...DEFAULT_CHAT_NOTIFICATIONS, sound: false, dnd: true });
    assert.equal(before.chatNotifications.dnd, false, "the cached document is not changed in place");
  });

  test("quiet hours go on with a range and off with null", () => {
    const on = applyChatPatch(settings(), { chatNotifications: { quietHours: { from: "22:00", to: "07:00" } } });
    assert.deepEqual(on.chatNotifications.quietHours, { from: "22:00", to: "07:00" });
    const off = applyChatPatch(on, { chatNotifications: { quietHours: null } });
    assert.equal(off.chatNotifications.quietHours, null);
  });

  test("a block the document lacks starts from the defaults", () => {
    const after = applyChatPatch(settings(), { chatNotifications: { inApp: false } });
    assert.deepEqual(after.chatNotifications, { ...DEFAULT_CHAT_NOTIFICATIONS, inApp: false });
  });

  test("the plain switches are copied as they are", () => {
    const after = applyChatPatch(settings({ closeToTray: true }), {
      closeToTray: false,
      startMinimized: false,
      chatOpenIn: "window",
      chatAutoDownloadMb: 5,
    });
    assert.equal(after.closeToTray, false);
    assert.equal(after.startMinimized, false);
    assert.equal(after.chatOpenIn, "window");
    assert.equal(after.chatAutoDownloadMb, 5);
    assert.equal(after.chatNotifications, undefined, "a patch without the block leaves it alone");
  });
});

describe("mutedChats", () => {
  const title = (c) => c.title;

  test("only chats whose level is not All messages, muted ones first", () => {
    const list = mutedChats(
      [
        conversation("a", "all", "Alpha"),
        conversation("b", "mentions", "Bravo"),
        conversation("c", "mute", "Charlie"),
        conversation("d", "mentions", "alpha cup"),
        conversation("e", "mute", "Delta"),
      ],
      title,
      "en",
    );
    assert.deepEqual(
      list.map((c) => c.id),
      ["c", "e", "d", "b"],
    );
  });

  test("no chat of its own level, no rows", () => {
    assert.deepEqual(mutedChats([conversation("a", "all")], title, "en"), []);
    assert.deepEqual(mutedChats([], title, "en"), []);
  });
});
