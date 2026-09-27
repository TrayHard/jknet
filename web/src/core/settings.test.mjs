import assert from "node:assert/strict";
import { test } from "node:test";

import { NEEDS_LAUNCHER } from "./errors.ts";
import { EventBus } from "./events.ts";
import { loadPrefs } from "./prefs.ts";
import { createSettings, DEFAULT_CHAT_NOTIFICATIONS, launcherDefaults } from "./settings.ts";
import { memoryStorage } from "./storage.ts";

async function setup() {
  const storage = memoryStorage();
  const prefs = await loadPrefs(storage);
  const events = new EventBus();
  const emitted = [];
  events.on("settings:chat-notifications", (payload) => emitted.push(payload));
  const settings = createSettings({ apiBase: "https://api.example.com", prefs, events, user: () => null });
  return { settings, prefs, storage, emitted };
}

test("the document is the launcher's defaults with the web's service", async () => {
  const { settings } = await setup();
  const document = settings.get();
  assert.deepEqual(document, launcherDefaults("https://api.example.com"));
  assert.equal(document.activeGame, "ja");
  assert.equal(document.language, "system");
  assert.equal(document.onlineUrl, "https://api.example.com");
  assert.deepEqual(document.chatNotifications, DEFAULT_CHAT_NOTIFICATIONS);
});

test("language, active game and chat switches are stored as preferences", async () => {
  const { settings, prefs, storage } = await setup();
  const next = await settings.update({ language: "ru", activeGame: "jo" });
  assert.equal(next.language, "ru");
  assert.equal(next.activeGame, "jo");
  assert.equal(prefs.get("locale"), "ru");
  assert.equal(await storage.get("prefs", "activeGame"), "jo");
  assert.equal(settings.get().activeGame, "jo");
});

test("the system language clears the stored one", async () => {
  const { settings, prefs } = await setup();
  await settings.update({ language: "de" });
  await settings.update({ language: "system" });
  assert.equal(prefs.get("locale"), undefined);
  assert.equal(settings.get().language, "system");
});

test("a chat switch merges into the rest and is announced once", async () => {
  const { settings, emitted } = await setup();
  const next = await settings.update({ chatNotifications: { sound: false } });
  assert.equal(next.chatNotifications.sound, false);
  assert.equal(next.chatNotifications.inApp, true);
  assert.deepEqual(emitted, [{ chatNotifications: next.chatNotifications }]);
  await settings.update({ chatNotifications: { sound: false } });
  assert.equal(emitted.length, 1, "an unchanged switch is not announced");
});

test("the chat sound is on by default and lives in this browser's own preference", async () => {
  const { settings, prefs } = await setup();
  assert.equal(settings.get().chatNotifications.sound, true);
  assert.equal(settings.get().chatNotifications.soundName, "default");
  assert.equal(prefs.get("sound"), undefined, "nothing is written until the player picks");

  const next = await settings.update({ chatNotifications: { sound: false, soundName: "comlink" } });
  assert.equal(next.chatNotifications.sound, false);
  assert.equal(next.chatNotifications.soundName, "comlink");
  assert.deepEqual(prefs.get("sound"), { on: false, name: "comlink" });
  assert.equal("sound" in (prefs.get("chatNotifications") ?? {}), false, "the other switches do not carry it");
  assert.equal("soundName" in (prefs.get("chatNotifications") ?? {}), false);

  await settings.update({ chatNotifications: { dnd: true } });
  assert.deepEqual(prefs.get("sound"), { on: false, name: "comlink" }, "another switch leaves the sound alone");
  assert.equal(settings.get().chatNotifications.dnd, true);
});

test("an unknown sound set is refused, and one stored by a newer build plays the default", async () => {
  const { settings, prefs } = await setup();
  await assert.rejects(settings.update({ chatNotifications: { soundName: "trumpet" } }), (error) => error.code === "invalidInput");
  await prefs.set("sound", { on: true, name: "trumpet" });
  assert.equal(settings.get().chatNotifications.soundName, "default");
  await prefs.set("sound", "loud");
  assert.equal(settings.get().chatNotifications.sound, true);
});

test("the sound outlives a sign-out, like the language", async () => {
  const { settings, prefs, storage } = await setup();
  await settings.update({ chatNotifications: { sound: false, inApp: false } });
  await storage.wipe();
  await prefs.restoreDevicePrefs();
  const after = settings.get().chatNotifications;
  assert.equal(after.sound, false);
  assert.equal(after.inApp, true, "the account's switches go with the account");
});

test("any other field is a launcher setting", async () => {
  const { settings } = await setup();
  for (const patch of [{ closeOnLaunch: true }, { onlineUrl: "https://evil.example.com" }, { language: "ru", favoriteServers: [] }]) {
    await assert.rejects(settings.update(patch), (error) => error.code === NEEDS_LAUNCHER);
  }
  assert.equal(settings.get().language, "system", "a refused patch changes nothing");
});

test("a value of the wrong shape is refused", async () => {
  const { settings } = await setup();
  await assert.rejects(settings.update({ activeGame: "q3" }), (error) => error.code === NEEDS_LAUNCHER);
  await assert.rejects(settings.update({ language: "xx" }), (error) => error.code === NEEDS_LAUNCHER);
});

test("fields left undefined are no change", async () => {
  const { settings } = await setup();
  const next = await settings.update({ language: undefined, closeOnLaunch: undefined });
  assert.equal(next.language, "system");
});
