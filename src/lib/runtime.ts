/**
 * Whether the frontend runs inside the Tauri webview.
 *
 * The same bundle is served two ways. `npm run tauri dev` puts it in the
 * WebView2 window, where every Tauri API works; `npm run dev` opens it in a
 * plain browser, which is how the layout and the tokens are reviewed without
 * building the core. In a browser `window.__TAURI_INTERNALS__` is missing and
 * a Tauri call throws a `TypeError` on the spot, before it can reject a
 * promise, so a `catch` around the call is not enough. Check here first
 * instead — in the IPC wrappers, in the window buttons and in the log setup.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** What every IPC wrapper rejects with outside the Tauri runtime. */
export const NO_RUNTIME_MESSAGE = "Tauri runtime is not available";
