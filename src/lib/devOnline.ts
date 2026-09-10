/**
 * Talking to `scripts/mock-online.mjs` from a plain browser.
 *
 * --- slice: friends ---
 *
 * `npm run dev` opens the frontend outside Tauri, where every command rejects
 * with `Tauri runtime is not available` — which is the whole review of the
 * Friends screen reduced to one error line, because that screen is nothing but
 * commands. This module stands in for the eight of them by calling the mock
 * service over `fetch`, so the layout can be checked without building the core and
 * without `npm run tauri dev`.
 *
 * It is development scaffolding, not a feature:
 *
 * - `friendsIpc` reaches it only when `isTauri()` is false **and**
 *   `import.meta.env.DEV` is true, and the second is a compile-time constant,
 *   so the branch and this module leave the production bundle.
 * - The presence it reports is invented. The real one comes from the core,
 *   which is where the game is started from; a browser has no game.
 * - `join_friend` fails on purpose: starting a process is exactly what a
 *   browser cannot do, and pretending otherwise would hide the difference.
 *
 * Start the mock first: `node scripts/mock-online.mjs`.
 */

import type { FriendsView, Invite, Presence, RequestSent } from "./ipc";

/**
 * Where the stand-in listens.
 *
 * `?online=http://127.0.0.1:8799` points somewhere else, which is what a machine
 * already running the real service on the stock port needs.
 */
const ONLINE =
  new URLSearchParams(window.location.search).get("online") ?? "http://127.0.0.1:8787";

/**
 * The token the mock issued, fetched once.
 *
 * `POST /v1/dev/token` is the mock's own shortcut, outside the contract: it
 * signs in without the browser round trip and hands back the same token a real
 * sign-in would have stored. In the launcher the token comes from
 * `settings.json` and never reaches the frontend at all.
 */
let issued: Promise<string> | null = null;

function token(): Promise<string> {
  issued ??= fetch(`${ONLINE}/v1/dev/token`, { method: "POST" })
    .then((response) => response.json() as Promise<{ token: string }>)
    .then((answer) => answer.token)
    .catch((e: unknown) => {
      // A failed fetch must not be remembered, or every later call would
      // reject with the same stale error after the mock is started.
      issued = null;
      throw e instanceof Error ? e : new Error(String(e));
    });
  return issued;
}

/**
 * A made-up presence so the Invite button has something to work with.
 *
 * In the launcher this is the player's real state, kept by the presence
 * reporter. Here it is a constant that says "in a game", because a browser
 * review of a button that only appears in a game is otherwise impossible.
 */
const PRESENCE: Presence = {
  status: "in_game",
  serverAddress: "203.0.113.10:29070",
  serverName: "EU FFA Nightly",
  clientName: "Everyday",
  since: new Date().toISOString(),
};

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${ONLINE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await token()}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed: unknown = text === "" ? null : JSON.parse(text);
  if (!response.ok) {
    const detail = parsed as { error?: { message?: string } } | null;
    throw new Error(detail?.error?.message ?? `the mock service answered ${response.status}`);
  }
  return parsed as T;
}

/** The signed-out view, for `http://localhost:14xx/?signedOut#/friends`. */
const SIGNED_OUT: FriendsView = {
  signedIn: false,
  live: false,
  friends: [],
  incoming: [],
  outgoing: [],
  invites: [],
  presence: { ...PRESENCE, status: "offline" },
};

/** Both documents the screen needs, in the shape the command answers with. */
async function view(): Promise<FriendsView> {
  if (new URLSearchParams(window.location.search).has("signedOut")) {
    return SIGNED_OUT;
  }
  const [friends, invites] = await Promise.all([
    call<Pick<FriendsView, "friends" | "incoming" | "outgoing">>("GET", "/v1/friends"),
    call<Invite[]>("GET", "/v1/invites"),
  ]);
  return { signedIn: true, live: false, ...friends, invites, presence: PRESENCE };
}

/** Runs one command against the mock service. Unknown commands reject. */
export async function devFriends<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const id = String(args.id ?? "");
  switch (command) {
    case "get_friends_state":
      return (await view()) as T;
    case "send_friend_request": {
      const answer = await call<{ to?: { displayName: string }; friend?: { user: { displayName: string } } }>(
        "POST",
        "/v1/friends/requests",
        { query: args.query },
      );
      const result: RequestSent = answer.friend
        ? {
            outcome: "accepted",
            displayName: answer.friend.user.displayName,
            state: await view(),
          }
        : {
            outcome: "requested",
            displayName: answer.to?.displayName ?? String(args.query),
            state: await view(),
          };
      return result as T;
    }
    case "accept_friend_request":
      await call("POST", `/v1/friends/requests/${id}/accept`);
      return (await view()) as T;
    case "decline_friend_request":
      await call("DELETE", `/v1/friends/requests/${id}`);
      return (await view()) as T;
    case "remove_friend":
      await call("DELETE", `/v1/friends/${String(args.userId)}`);
      return (await view()) as T;
    case "send_invite":
      return (await call<Invite>("POST", "/v1/invites", args)) as T;
    case "dismiss_invite":
      await call("DELETE", `/v1/invites/${id}`);
      return (await view()) as T;
    default:
      // `join_friend` lands here, and so does anything added later without a
      // stand-in. Starting a game is the one thing a browser cannot fake.
      throw new Error(`${command} needs the launcher; a browser cannot run it`);
  }
}
