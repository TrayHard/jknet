/**
 * The chats of friends' private servers the web app may join without
 * playing (spec 1.11): the list the service keeps, and the join.
 *
 * `GET /v1/chat/servers/joinable` names every server of an accepted friend
 * whose chat is open, that opens to the player by its join policy or by a
 * live invite, whose host lets the web app in, and whose chat the player is
 * not in yet. `POST /v1/chat/servers/{sessionId}/join` makes the player a
 * member of it. Neither carries an address or a password, and nothing here
 * ever joins the game.
 *
 * The list changes without a word to this device in several ways, so the
 * core tells the screens to ask again (`chat:joinable`) whenever one of them
 * may have happened: the socket opened, the service said so
 * (`chat.serverJoinable`), a friend's hosting appeared, vanished or changed,
 * or an invite came or went.
 */

import type { Conversation, Game, JoinableServer, Presence } from "../../../../src/lib/ipc.ts";
import { invalidInput, signedOut } from "../errors.ts";
import { EVENTS, type EventBus } from "../events.ts";
import { segment, type Http } from "../http.ts";
import type { Frame } from "../socket.ts";
import { readConversation } from "./wire.ts";

/** `chatEvents.joinable` of `lib/ipc.ts`: the list may have changed, refetch it. */
export const JOINABLE_EVENT = "chat:joinable";
/** The frame the service sends the host's friends when a server chat opens or ends. */
export const JOINABLE_FRAME = "chat.serverJoinable";

export interface ServerChatsDeps {
  http: Http;
  events: EventBus;
  signedIn(): boolean;
  /** Takes the conversation a join answered into the chat's book. */
  keep(conversation: Conversation): void;
}

export interface ServerChats {
  joinable(): Promise<JoinableServer[]>;
  join(hostUserId: string, sessionId: string): Promise<Conversation>;
  /** Takes `chat.serverJoinable`; answers whether it was that frame. */
  handleFrame(frame: Frame): boolean;
  /** The socket opened: whatever changed while it was down is unknown. */
  connected(): void;
  /** Forgets what the friends hosted: the account went, or another tab took over. */
  stop(): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One row of the list, read leniently: a row that lacks its host or its session is left out. */
export function readJoinable(raw: unknown): JoinableServer | null {
  if (!isObject(raw)) return null;
  const { hostUserId, sessionId } = raw;
  if (typeof hostUserId !== "string" || hostUserId === "" || typeof sessionId !== "string" || sessionId === "") return null;
  const game: Game = raw.game === "jo" ? "jo" : "ja";
  const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0);
  return {
    hostUserId,
    sessionId,
    game,
    map: typeof raw.map === "string" ? raw.map : "",
    mod: typeof raw.mod === "string" && raw.mod !== "" ? raw.mod : null,
    gametype: count(raw.gametype),
    members: count(raw.members),
    invited: raw.invited === true,
  };
}

function nonEmpty(value: string, what: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw invalidInput(`an empty ${what}`);
  return trimmed;
}

export function createServerChats(deps: ServerChatsDeps): ServerChats {
  const { http, events } = deps;
  /** The session each friend hosts, as the presence events said last. */
  const hosting = new Map<string, string | null>();

  const changed = () => events.emit(JOINABLE_EVENT, {});

  // The bus lives as long as the core: these listeners are never taken off.
  events.on(EVENTS.friendsPresence, (payload) => {
    if (!isObject(payload) || typeof payload.userId !== "string") return;
    const presence = payload.presence as Presence | null | undefined;
    const session = presence?.hosting?.sessionId ?? null;
    const before = hosting.has(payload.userId) ? hosting.get(payload.userId) : undefined;
    hosting.set(payload.userId, session);
    // A friend seen for the first time without a server changes nothing.
    if (before === undefined ? session !== null : before !== session) changed();
  });
  events.on(EVENTS.friendsInvite, changed);

  return {
    async joinable() {
      if (!deps.signedIn()) throw signedOut();
      const answer = await http.request<{ servers?: unknown }>("GET", "/v1/chat/servers/joinable");
      const rows = Array.isArray(answer?.servers) ? answer.servers : [];
      return rows.flatMap((row) => {
        const server = readJoinable(row);
        return server === null ? [] : [server];
      });
    },

    async join(hostUserId, sessionId) {
      if (!deps.signedIn()) throw signedOut();
      const host = nonEmpty(hostUserId, "host");
      const session = nonEmpty(sessionId, "session");
      const raw = await http.request<unknown>("POST", `/v1/chat/servers/${segment(session)}/join`, {
        body: { hostUserId: host },
      });
      const conversation = readConversation(raw);
      deps.keep(conversation);
      changed();
      return conversation;
    },

    handleFrame(frame) {
      if (frame.type !== JOINABLE_FRAME) return false;
      changed();
      return true;
    },

    connected: changed,

    stop() {
      hosting.clear();
    },
  };
}
