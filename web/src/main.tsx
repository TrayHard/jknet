/**
 * The web app's entry point.
 *
 * 1. The language: the one stored on this device, else the browser's.
 * 2. The core, registered as the backend before anything renders, so the
 *    shared hooks and IPC wrappers reach it from the first call.
 * 3. The React tree: the one-tab gate starts the core, then the providers
 *    and the router render.
 * 4. After the first render, the service worker and the update checks.
 */

import React from "react";
import ReactDOM from "react-dom/client";

import { setBackend } from "../../src/lib/backend.ts";
import { App } from "./app/App.tsx";
import { deviceKind, deviceName } from "./app/device.ts";
import { startPwa } from "./app/pwa.ts";
import { createWebCore } from "./core/index.ts";
import { loadPrefs } from "./core/prefs.ts";
import type { CoreStats } from "./core/router.ts";
import { openStorage } from "./core/storage.ts";
import { i18next, initWebI18n, startLanguage } from "./i18n.ts";
import "./web.css";

declare global {
  interface Window {
    /** Non-production builds: what the e2e run checks after every test. */
    __jknetStats?: CoreStats;
    /** Non-production builds: the chat's state, for the e2e run to read what the screens draw from. */
    __jknetChat?: { view(): unknown; idle(): boolean };
  }
}

/** Whether this build exposes its counters to the e2e run. */
const EXPOSE_STATS = import.meta.env.MODE !== "production";

async function start(): Promise<void> {
  const storage = await openStorage();
  const prefs = await loadPrefs(storage);
  const core = createWebCore({
    apiBase: import.meta.env.VITE_JKNET_API,
    storage,
    prefs,
    device: { kind: deviceKind, name: deviceName },
    origin: window.location.origin,
    // The words the core writes into a notification itself, as the launcher's tray labels.
    texts: () => ({
      newMessage: i18next.t("chat:tray.newMessage"),
      deletedAccount: i18next.t("chat:people.deleted"),
    }),
  });
  if (EXPOSE_STATS) {
    window.__jknetStats = core.stats;
    window.__jknetChat = { view: () => core.chat.view(), idle: () => core.chat.idle() };
  }
  setBackend(core.backend);

  try {
    await initWebI18n(startLanguage(prefs.get("locale")), EXPOSE_STATS ? core.stats : undefined);
  } catch (error) {
    console.error("Starting the interface language failed", error);
  }

  const root = document.getElementById("root");
  if (root === null) throw new Error("index.html is missing the #root element");
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App core={core} />
    </React.StrictMode>,
  );

  if (!import.meta.env.DEV) {
    // An update applies by itself only while no message waits to go out; the
    // staged files of the chat join this answer with the files.
    void startPwa(() => !core.chat.busy());
  }
}

void start().catch((error: unknown) => {
  console.error("The web app did not start", error);
});
