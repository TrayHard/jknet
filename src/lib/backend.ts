/**
 * The seam between the shared frontend and whatever answers its commands.
 *
 * The launcher and the web app run the same screens, hooks and IPC wrappers.
 * In the launcher the Rust core answers every command and sends every event
 * (`backend-tauri.ts`); in the web app a core written in TypeScript does,
 * over the JKNet Online API. `lib/ipc.ts` and the event hooks of
 * `lib/queries.ts` reach either one only through this module, so neither of
 * them imports `@tauri-apps` for a call or a listener.
 *
 * The entry point registers its backend before anything renders:
 * `src/main.tsx` the Tauri one when the page runs inside Tauri. With none
 * registered — `npm run dev` in a plain browser — `hasBackend()` is `false`,
 * every IPC wrapper rejects with `NO_RUNTIME_MESSAGE` as it always did, and
 * `usePlatform()` answers the launcher's switches: only the launcher runs
 * without a backend, in that browser stand, whose stand-ins (`devChat`,
 * `devHost`, `devOnline`) draw the launcher's screens for review.
 *
 * `isTauri()` keeps its own meaning: "this is the native shell". A hook the
 * web app mounts asks `hasBackend()`; a window button, the tray or a local
 * file asks `isTauri()`.
 */

import { NO_RUNTIME_MESSAGE } from "./runtime.ts";

/**
 * What the platform under the screens can do. A shared component hides the
 * controls whose work needs a switch that is off.
 */
export interface PlatformCaps {
  /** Start the game: join a server, host one, launch a client. */
  game: boolean;
  /** Game clients and files on this machine: install, import, apply. */
  localFiles: boolean;
  /** The system's file and save dialogs, run by the core. */
  nativeDialogs: boolean;
  tray: boolean;
  /** More than one window: the chat window, the client windows. */
  windows: boolean;
  /** Ask a game server directly over UDP. */
  serverQuery: boolean;
}

/** Stops one listener. */
export type UnlistenFn = () => void;

/** One event as a listener receives it. */
export interface BackendEvent<T> {
  payload: T;
}

/**
 * Which listeners hear an event. `own` is this window only, for the events
 * the Tauri core sends to one window with `emit_to`; `any` hears every
 * target. A backend with one window treats both alike.
 */
export interface ListenOptions {
  target?: "any" | "own";
}

export interface Backend {
  kind: "tauri" | "web";
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(
    event: string,
    handler: (event: BackendEvent<T>) => void,
    options?: ListenOptions,
  ): Promise<UnlistenFn>;
  emitTo(target: string, event: string, payload?: unknown): Promise<void>;
  /** A local path as an address the page may load. */
  convertFileSrc(path: string): string;
  /** An http(s) address in the system browser, or a new tab of it. */
  openExternal(url: string): Promise<void>;
  caps: PlatformCaps;
}

/**
 * What the launcher can do. A page without a backend is the launcher's
 * browser stand (`npm run dev`), so it draws the launcher's controls too.
 */
export const LAUNCHER_CAPS: PlatformCaps = Object.freeze({
  game: true,
  localFiles: true,
  nativeDialogs: true,
  tray: true,
  windows: true,
  serverQuery: true,
});

let current: Backend | null = null;

/** Registers the backend. Called once, by the entry point, before rendering. */
export function setBackend(next: Backend): void {
  current = next;
}

/** Whether a backend answers commands: the launcher, or the web app's core. */
export function hasBackend(): boolean {
  return current !== null;
}

/** The registered backend. Throws the IPC wrappers' sentence when there is none. */
export function backend(): Backend {
  if (current === null) throw new Error(NO_RUNTIME_MESSAGE);
  return current;
}

export const invoke: Backend["invoke"] = <T>(command: string, args?: Record<string, unknown>) =>
  backend().invoke<T>(command, args);

export const listen: Backend["listen"] = <T>(
  event: string,
  handler: (event: BackendEvent<T>) => void,
  options?: ListenOptions,
) => backend().listen<T>(event, handler, options);

export const emitTo: Backend["emitTo"] = (target, event, payload) =>
  backend().emitTo(target, event, payload);

export const convertFileSrc: Backend["convertFileSrc"] = (path) => backend().convertFileSrc(path);

/**
 * What the platform can do, for a component that hides what it cannot.
 * Without a backend, the launcher's switches: see `LAUNCHER_CAPS`.
 *
 * Not React state: the entry point registers the backend before the first
 * render and never swaps it, so every render reads the same answer.
 */
export function usePlatform(): PlatformCaps {
  return current?.caps ?? LAUNCHER_CAPS;
}
