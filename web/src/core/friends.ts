/**
 * Friends, requests and server invites: the commands of the Friends screens
 * and the frames that move them.
 *
 * A port of `src-tauri/src/friends/` minus the game: the same `FriendsView`
 * document answers every command, so the shared hooks keep one writer for the
 * four lists, and the frames become the same three events.
 *
 * | Frame              | Event                                         |
 * | ------------------ | --------------------------------------------- |
 * | `presence.updated` | `friends:presence`: patch one row             |
 * | `invite`           | `friends:invite` and `friends:changed`        |
 * | `friend.request`, `friend.accepted`, `friend.removed` | `friends:changed` |
 * | `me.updated`       | `friends:changed`, and the account's new name |
 *
 * While the socket is down the lists are asked for again every 30 s, as the
 * launcher does, so the screen stays honest without the live stream.
 */

import { onlineError } from "./errors.ts";
import { EVENTS, type EventBus } from "./events.ts";
import { segment, type Http } from "./http.ts";
import type { Frame } from "./socket.ts";
import type {
  Friend,
  FriendRequest,
  FriendsView,
  Invite,
  OnlineUser,
  Presence,
  RequestSent,
  WebDevice,
} from "../../../src/lib/ipc.ts";

/** How often the lists are refetched while the socket is down. */
export const FALLBACK_REFRESH_MS = 30_000;
/** The longest friend query the launcher sends. */
export const MAX_QUERY_LEN = 96;

interface FriendsListWire {
  friends: Friend[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
}

export interface FriendsCore {
  state(): Promise<FriendsView>;
  sendRequest(query: string): Promise<RequestSent>;
  accept(id: string): Promise<FriendsView>;
  decline(id: string): Promise<FriendsView>;
  remove(userId: string): Promise<FriendsView>;
  dismissInvite(id: string): Promise<FriendsView>;
  handleFrame(frame: Frame): boolean;
  /** The socket opened: everything may have moved while it was down. */
  connected(): void;
  /** The socket's state changed: the fallback timer runs while it is down. */
  setLive(live: boolean): void;
  stop(): void;
}

/** What this browser tells friends about itself: online, from the web app. */
export function webPresence(device: WebDevice, since: string): Presence {
  return {
    status: "online",
    serverAddress: null,
    serverName: null,
    clientName: null,
    since,
    via: "web",
    device,
  };
}

/** The view of a browser nobody signed in to. */
export function signedOutView(presence: Presence): FriendsView {
  return { signedIn: false, live: false, friends: [], incoming: [], outgoing: [], invites: [], presence };
}

/** Newest invite first, and none that expired. */
export function openInvites(invites: Invite[], now: number): Invite[] {
  return invites
    .filter((invite) => {
      const expires = Date.parse(invite.expiresAt);
      return Number.isNaN(expires) || expires > now;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Trims a friend query and refuses the two shapes the service cannot use. */
export function cleanQuery(query: string): string {
  const trimmed = query.trim();
  if (trimmed === "") throw onlineError("invalid", "Type a display name, a jkhub: name or a user id", 400);
  if ([...trimmed].length > MAX_QUERY_LEN) {
    throw onlineError("invalid", `That name is longer than ${MAX_QUERY_LEN} characters`, 400);
  }
  return trimmed;
}

export function createFriends(deps: {
  http: Http;
  events: EventBus;
  signedIn(): boolean;
  device(): WebDevice;
  live(): boolean;
  /** `me.updated`: the account's new name. */
  meUpdated(user: OnlineUser): void;
}): FriendsCore {
  const { http, events } = deps;
  const since = new Date().toISOString();
  let fallback: ReturnType<typeof setInterval> | undefined;

  const mine = () => webPresence(deps.device(), since);

  const state = async (): Promise<FriendsView> => {
    if (!deps.signedIn()) return signedOutView(mine());
    const [list, invites] = await Promise.all([
      http.request<FriendsListWire>("GET", "/v1/friends"),
      http.request<Invite[]>("GET", "/v1/invites"),
    ]);
    return {
      signedIn: true,
      live: deps.live(),
      friends: list.friends,
      incoming: list.incoming,
      outgoing: list.outgoing,
      invites: openInvites(invites, Date.now()),
      presence: mine(),
    };
  };

  const changed = () => events.emit(EVENTS.friendsChanged);

  return {
    state,
    sendRequest: async (query: string) => {
      const answer = await http.send<{ id?: string; to?: OnlineUser; friend?: Friend }>(
        "POST",
        "/v1/friends/requests",
        { body: { query: cleanQuery(query) } },
      );
      const view = await state();
      if (answer.status === 201 && answer.data.to !== undefined) {
        return { outcome: "requested", displayName: answer.data.to.displayName, state: view };
      }
      if (answer.data.friend !== undefined) {
        return { outcome: "accepted", displayName: answer.data.friend.user.displayName, state: view };
      }
      throw onlineError("internal", "the service accepted the request without saying what happened", answer.status);
    },
    accept: async (id: string) => {
      await http.request("POST", `/v1/friends/requests/${segment(id)}/accept`);
      return state();
    },
    decline: async (id: string) => {
      await http.request("DELETE", `/v1/friends/requests/${segment(id)}`);
      return state();
    },
    remove: async (userId: string) => {
      await http.request("DELETE", `/v1/friends/${segment(userId)}`);
      return state();
    },
    dismissInvite: async (id: string) => {
      await http.request("DELETE", `/v1/invites/${segment(id)}`);
      return state();
    },
    handleFrame: (frame: Frame) => {
      switch (frame.type) {
        case "presence.updated": {
          const payload = frame.payload as { userId?: unknown; presence?: unknown } | undefined;
          if (typeof payload?.userId === "string" && payload.presence !== null && typeof payload.presence === "object") {
            events.emit(EVENTS.friendsPresence, { userId: payload.userId, presence: payload.presence });
          }
          return true;
        }
        case "invite": {
          const invite = (frame.payload as { invite?: Invite } | undefined)?.invite ?? (frame.payload as Invite);
          if (invite !== null && typeof invite === "object" && typeof invite.id === "string") {
            events.emit(EVENTS.friendsInvite, invite);
          }
          changed();
          return true;
        }
        case "me.updated": {
          const user = (frame.payload as { user?: OnlineUser } | undefined)?.user;
          if (user !== undefined && typeof user.id === "string") deps.meUpdated(user);
          changed();
          return true;
        }
        case "friend.request":
        case "friend.accepted":
        case "friend.removed":
          changed();
          return true;
        default:
          return false;
      }
    },
    connected: changed,
    setLive: (live: boolean) => {
      if (live) {
        if (fallback !== undefined) clearInterval(fallback);
        fallback = undefined;
        changed();
        return;
      }
      if (fallback === undefined && deps.signedIn()) {
        fallback = setInterval(() => {
          if (deps.signedIn()) changed();
        }, FALLBACK_REFRESH_MS);
      }
    },
    stop: () => {
      if (fallback !== undefined) clearInterval(fallback);
      fallback = undefined;
    },
  };
}
