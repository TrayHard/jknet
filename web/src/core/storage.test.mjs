import assert from "node:assert/strict";
import { test } from "node:test";

import { IDBFactory } from "fake-indexeddb";

import { DB_NAME, memoryStorage, openStorage, STORES } from "./storage.ts";
import { loadPrefs } from "./prefs.ts";

test("the database has the six stores of version 1", async () => {
  const factory = new IDBFactory();
  const storage = await openStorage(factory);
  assert.equal(storage.durable, true);
  const names = await new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, 1);
    request.onsuccess = () => {
      const list = [...request.result.objectStoreNames];
      request.result.close();
      resolve(list);
    };
    request.onerror = () => reject(request.error);
  });
  storage.close();
  assert.deepEqual([...names].sort(), [...STORES].sort());
});

test("values round-trip and deletes stick", async () => {
  const storage = await openStorage(new IDBFactory());
  await storage.put("session", "current", { token: "t", userId: "u", apiBase: "https://api.example.com", createdAt: "x" });
  assert.deepEqual(await storage.get("session", "current"), {
    token: "t",
    userId: "u",
    apiBase: "https://api.example.com",
    createdAt: "x",
  });
  await storage.delete("session", "current");
  assert.equal(await storage.get("session", "current"), undefined);
});

test("entries lists keys with their values", async () => {
  const storage = await openStorage(new IDBFactory());
  await storage.put("prefs", "locale", "ru");
  await storage.put("prefs", "activeGame", "jo");
  const entries = await storage.entries("prefs");
  assert.deepEqual(
    entries.sort((a, b) => a.key.localeCompare(b.key)),
    [
      { key: "activeGame", value: "jo" },
      { key: "locale", value: "ru" },
    ],
  );
});

test("wipe deletes the database and the storage works again afterwards", async () => {
  const factory = new IDBFactory();
  const storage = await openStorage(factory);
  await storage.put("drafts", "c1", { text: "hi", updatedAt: "x" });
  await storage.wipe();
  assert.equal(await storage.get("drafts", "c1"), undefined);
  await storage.put("drafts", "c2", { text: "again", updatedAt: "y" });
  assert.deepEqual(await storage.get("drafts", "c2"), { text: "again", updatedAt: "y" });
});

test("a browser without IndexedDB gets a store in memory", async () => {
  const storage = await openStorage(undefined);
  assert.equal(storage.durable, false);
  await storage.put("prefs", "locale", "de");
  assert.equal(await storage.get("prefs", "locale"), "de");
});

test("a factory that fails to open falls back to memory", async () => {
  const broken = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.error = new Error("denied");
        request.onerror?.();
      });
      return request;
    },
  };
  const storage = await openStorage(broken);
  assert.equal(storage.durable, false);
  await storage.put("outbox", "01J", { clientId: "01J" });
  assert.deepEqual(await storage.get("outbox", "01J"), { clientId: "01J" });
});

test("the memory store copies values like IndexedDB does", async () => {
  const storage = memoryStorage();
  const value = { text: "a" };
  await storage.put("drafts", "c", value);
  value.text = "changed";
  assert.deepEqual(await storage.get("drafts", "c"), { text: "a" });
});

test("sign-out keeps the device's language and drops the rest", async () => {
  const storage = await openStorage(new IDBFactory());
  const prefs = await loadPrefs(storage);
  await prefs.set("locale", "uk");
  await prefs.set("activeGame", "jo");
  await storage.wipe();
  await prefs.restoreDevicePrefs();
  assert.equal(prefs.get("locale"), "uk");
  assert.equal(prefs.get("activeGame"), undefined);
  const reloaded = await loadPrefs(storage);
  assert.deepEqual(reloaded.all(), { locale: "uk" });
});
