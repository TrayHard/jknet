/**
 * The devices signed in to the account (spec 1.8): `get_sessions` and
 * `revoke_session` of `lib/ipc.ts`, the commands the launcher's Rust core
 * answers from `online/client.rs`, here over `/v1/me/sessions`.
 *
 * A session is one token: one per launcher and per browser that signed in.
 * The list names each with its client, the web app's device kind, the name
 * it gave itself, when it was last used, and whether it is this browser,
 * has a live socket or receives push. Signing another session out deletes
 * its token on the service; its sockets close with 4401 and a launcher
 * learns on its next request, which answers `401`.
 *
 * Signing this browser's own session out is the ordinary sign-out of this
 * device (`session.ts`): the service hears the logout, and the database,
 * the file cache, the notifications and the push subscription go with it.
 * The service reads its budget of these routes per account, so the list is
 * read only when a screen asks for it, never on a timer.
 */

import type { DeviceSession, WebDevice } from "../../../src/lib/ipc.ts";
import { invalidInput, signedOut } from "./errors.ts";
import { segment, type Http } from "./http.ts";

export interface SessionsDeps {
  http: Http;
  signedIn(): boolean;
  /** Signs this browser out, the way **Sign out** of the account screen does. */
  signOut(): Promise<void>;
  /** Whether this browser's own socket is up or on its way up. */
  live(): boolean;
}

/** What `revoke_session` sends: one session by id, or every other one. */
export interface RevokeTarget {
  id: string | null;
  others: boolean;
}

export interface SessionsCore {
  /** `get_sessions`: every live session of the account, the most recently used first. */
  list(): Promise<DeviceSession[]>;
  /** `revoke_session`: signs one session out, every other one, or this browser. */
  revoke(target: RevokeTarget): Promise<void>;
  /** Forgets which session is this browser's: the account went. */
  forget(): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * One row of `GET /v1/me/sessions`, read leniently: a row without an id is
 * left out, an unknown client reads as a launcher and an unknown device
 * kind as none, as the launcher's reader of the same list does.
 */
export function readSession(raw: unknown): DeviceSession | null {
  if (!isObject(raw)) return null;
  const id = text(raw.id);
  if (id === null || id === "") return null;
  const client = raw.client === "web" ? "web" : "launcher";
  const device: WebDevice | null = raw.device === "phone" || raw.device === "desktop" ? raw.device : null;
  const name = text(raw.deviceName);
  return {
    id,
    client,
    device: client === "web" ? device : null,
    deviceName: name === null || name.trim() === "" ? null : name,
    createdAt: text(raw.createdAt) ?? "",
    lastUsedAt: text(raw.lastUsedAt) ?? "",
    expiresAt: text(raw.expiresAt) ?? "",
    current: raw.current === true,
    online: raw.online === true,
    push: raw.push === true,
  };
}

/** The arguments of `revoke_session` as the IPC wrapper sends them. */
export function readTarget(args: Record<string, unknown>): RevokeTarget {
  const id = typeof args.id === "string" && args.id.trim() !== "" ? args.id.trim() : null;
  return { id, others: args.others === true };
}

export function createSessions(deps: SessionsDeps): SessionsCore {
  const { http } = deps;
  /** The id of this browser's own session, once a list has named it. */
  let currentId: string | null = null;

  const list = async (): Promise<DeviceSession[]> => {
    if (!deps.signedIn()) throw signedOut();
    const answer = await http.request<{ sessions?: unknown }>("GET", "/v1/me/sessions");
    const rows = Array.isArray(answer?.sessions) ? answer.sessions : [];
    const sessions = rows.flatMap((row) => {
      const session = readSession(row);
      return session === null ? [] : [session];
    });
    const current = sessions.find((session) => session.current);
    currentId = current?.id ?? currentId;
    // A screen that opens with the app reads the list before this
    // browser's socket is up: the service does not see it yet, but it is.
    if (current !== undefined && !current.online && deps.live()) current.online = true;
    return sessions;
  };

  return {
    list,

    async revoke(target) {
      if (!deps.signedIn()) throw signedOut();
      if (target.others) {
        if (target.id !== null) throw invalidInput("a session id together with others");
        await http.request("DELETE", "/v1/me/sessions?others=true");
        return;
      }
      if (target.id === null) {
        await deps.signOut();
        return;
      }
      // Deleting this browser's own token on the service would leave the
      // page signed in until the socket closed: it is the sign-out instead.
      // A caller that never read the list learns which session is this one.
      if (currentId === null) await list();
      if (target.id === currentId) {
        await deps.signOut();
        return;
      }
      await http.request("DELETE", `/v1/me/sessions/${segment(target.id)}`);
    },

    forget() {
      currentId = null;
    },
  };
}
