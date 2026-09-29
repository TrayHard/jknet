/**
 * Tests for src/lib/backend.ts: what the shared frontend sees with no
 * backend registered, and that every call reaches the registered one as it
 * was made.
 *
 * The module keeps one backend for the page, so the tests run in order: the
 * first ones before anything is registered.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  backend,
  convertFileSrc,
  emitTo,
  hasBackend,
  invoke,
  listen,
  setBackend,
  usePlatform,
} from "./backend.ts";
import { NO_RUNTIME_MESSAGE } from "./runtime.ts";

const ALL_ON = {
  game: true,
  localFiles: true,
  nativeDialogs: true,
  tray: true,
  windows: true,
  serverQuery: true,
};

const ALL_OFF = {
  game: false,
  localFiles: false,
  nativeDialogs: false,
  tray: false,
  windows: false,
  serverQuery: false,
};

/** A backend that writes down every call. */
function recordingBackend() {
  const calls = [];
  return {
    calls,
    backend: {
      kind: "web",
      invoke: async (command, args) => {
        calls.push(["invoke", command, args]);
        return { answered: command };
      },
      listen: async (event, handler, options) => {
        calls.push(["listen", event, options]);
        handler({ payload: `${event} payload` });
        return () => calls.push(["unlisten", event]);
      },
      emitTo: async (target, event, payload) => {
        calls.push(["emitTo", target, event, payload]);
      },
      convertFileSrc: (path) => `converted:${path}`,
      openExternal: async (url) => {
        calls.push(["openExternal", url]);
      },
      caps: { ...ALL_OFF, serverQuery: true },
    },
  };
}

describe("without a backend", () => {
  test("nothing answers, and the screens draw the launcher's controls for the browser stand", () => {
    assert.equal(hasBackend(), false);
    assert.deepEqual(usePlatform(), ALL_ON);
  });

  test("a call fails with the sentence the IPC wrappers print", () => {
    assert.throws(() => backend(), { message: NO_RUNTIME_MESSAGE });
    assert.throws(() => invoke("get_settings"), { message: NO_RUNTIME_MESSAGE });
    assert.throws(() => convertFileSrc("C:/x.png"), { message: NO_RUNTIME_MESSAGE });
  });

  test("the answer of usePlatform cannot be changed by a caller", () => {
    assert.throws(() => {
      usePlatform().game = false;
    });
    assert.equal(usePlatform().game, true);
  });
});

describe("with a backend", () => {
  const recorded = recordingBackend();

  test("the registered backend answers", () => {
    setBackend(recorded.backend);
    assert.equal(hasBackend(), true);
    assert.equal(backend().kind, "web");
    assert.deepEqual(usePlatform(), { ...ALL_OFF, serverQuery: true });
  });

  test("a command reaches it with its arguments", async () => {
    assert.deepEqual(await invoke("chat_get_state"), { answered: "chat_get_state" });
    await invoke("chat_open_direct", { userId: "u1" });
    assert.deepEqual(recorded.calls.slice(-2), [
      ["invoke", "chat_get_state", undefined],
      ["invoke", "chat_open_direct", { userId: "u1" }],
    ]);
  });

  test("a listener gets the event and the target it asked for", async () => {
    const heard = [];
    const stop = await listen("chat:open", (event) => heard.push(event.payload), { target: "own" });
    assert.deepEqual(heard, ["chat:open payload"]);
    assert.deepEqual(recorded.calls.at(-1), ["listen", "chat:open", { target: "own" }]);
    stop();
    assert.deepEqual(recorded.calls.at(-1), ["unlisten", "chat:open"]);
  });

  test("emitTo and convertFileSrc go through as well", async () => {
    await emitTo("main", "chat:open", { conversationId: "c" });
    assert.deepEqual(recorded.calls.at(-1), ["emitTo", "main", "chat:open", { conversationId: "c" }]);
    assert.equal(convertFileSrc("blob:x"), "converted:blob:x");
  });
});
