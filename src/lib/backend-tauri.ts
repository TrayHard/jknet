/**
 * The backend of the launcher: the Rust core behind the Tauri IPC.
 *
 * `src/main.tsx` registers it when the page runs inside Tauri. Every call and
 * listener goes exactly where it went before the seam existed: `invoke` of
 * `@tauri-apps/api/core`, `listen` of `@tauri-apps/api/event`, and for an
 * event the core sends to one window, the listener of this webview window.
 * The board-shots stand mocks the same IPC, so it runs on this backend too.
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { Backend, BackendEvent, ListenOptions } from "./backend";

export const tauriBackend: Backend = {
  kind: "tauri",
  invoke: <T>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args),
  listen: <T>(event: string, handler: (event: BackendEvent<T>) => void, options?: ListenOptions) =>
    // `emit_to` of the core reaches a plain `listen` of every window as well,
    // so a window listens on itself for the events meant for it alone.
    options?.target === "own"
      ? getCurrentWebviewWindow().listen<T>(event, handler)
      : listen<T>(event, handler),
  emitTo: (target, event, payload) => emitTo(target, event, payload),
  convertFileSrc: (path) => convertFileSrc(path),
  openExternal: (url) => openUrl(url),
  caps: {
    game: true,
    localFiles: true,
    nativeDialogs: true,
    tray: true,
    windows: true,
    serverQuery: true,
  },
};
