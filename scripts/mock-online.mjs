/**
 * A stand-in for JKNet Online, for developing the launcher without one.
 *
 * The real service is a separate service. This script answers the part of API v1
 * the launcher uses — sign-in, the account, friends, presence, invites, the
 * live socket, bundles and chat — keeps everything in memory, and depends on nothing
 * but Node itself, so it starts in the time it takes to read this sentence and
 * forgets everything when it stops.
 *
 * Run it:
 *
 *     node scripts/mock-online.mjs
 *     node scripts/mock-online.mjs --port 8799
 *
 * Then point the launcher at it: the stock `onlineUrl` is already
 * `http://127.0.0.1:8787`, which is where this listens by default.
 *
 * What it implements:
 *
 *     POST   /v1/auth/login-sessions      dev works, jkhub and discord refuse
 *     GET    /v1/auth/login-sessions/:id  pending, then done with the token
 *     GET    /v1/auth/dev/start?session=  the form the browser opens
 *     GET    /v1/auth/dev/callback        ?state=&name=, what the form submits
 *     POST   /v1/auth/logout
 *     GET    /v1/me      PATCH /v1/me      DELETE /v1/me
 *     GET    /v1/friends                  three friends, two open requests
 *     POST   /v1/friends/requests         201 asked, 200 already asked me
 *     POST   /v1/friends/requests/:id/accept
 *     DELETE /v1/friends/requests/:id     declines one, cancels the other
 *     DELETE /v1/friends/:userId
 *     PUT    /v1/presence
 *     GET    /v1/invites  POST /v1/invites  DELETE /v1/invites/:id
 *     GET    /v1/ws                       the live socket; the token in
 *                                         Authorization or, as older
 *                                         launchers send it, in ?token=
 *     GET    /v1/bundles?game=&sort=&q=&engine=&tag=&limit=&offset=
 *                                         three sample bundles for ja, one of
 *                                         them of three components and in
 *                                         Russian with an English translation;
 *                                         the engine filter matches any
 *                                         component, q searches every language
 *     GET    /v1/bundles/me               the account's bundles and quota
 *     GET    /v1/bundles/admin/pending    the review queue, one sample
 *     POST   /v1/bundles/admin/versions/:versionId   approve or reject
 *     POST   /v1/bundles/admin/:id        featured and hidden
 *     POST   /v1/bundles                  PUT /v1/bundles/:id  DELETE /v1/bundles/:id
 *                                         the description is Markdown of up to
 *                                         32 KiB whose blob:<sha256> pictures
 *                                         must be uploaded pictures; language
 *                                         and translations as the service
 *                                         takes them, PUT replaces the set
 *     GET    /v1/bundles/:id              GET /v1/bundles/:id/versions/:versionId
 *     POST   /v1/bundles/:id/versions     the schema 2 manifest, answers missingBlobs;
 *                                         a pk3 may carry a listing, a file of the store
 *     POST   /v1/bundles/:id/versions/:versionId/publish
 *     DELETE /v1/bundles/:id/versions/:versionId
 *     PUT    /v1/bundles/:id/like         DELETE /v1/bundles/:id/like
 *     POST   /v1/bundles/:id/installs
 *     PUT    /v1/blobs/:sha256            the file, kept in memory; a picture is
 *                                         told by its first bytes
 *     GET    /v1/blobs/:sha256            HEAD too, one Range; a picture comes
 *                                         with its Content-Type and inline
 *     *      /v1/relay/*                  503 relay_unavailable: the mock has no
 *                                         relay node; the launcher's server
 *                                         stays up for the local network
 *     GET    /v1/chat/conversations       the chat sync document
 *     GET    /v1/chat/conversations/:id   PUT /v1/chat/direct/:userId
 *     POST   /v1/chat/groups              PATCH /v1/chat/groups/:id (owner only)
 *     POST   /v1/chat/groups/:id/members  POST /v1/chat/groups/:id/join
 *     DELETE /v1/chat/groups/:id/invites/:userId
 *     DELETE /v1/chat/conversations/:id/members/:userId
 *     PUT    /v1/chat/servers/:sessionId  POST …/join  PATCH (host only)  DELETE
 *     GET    /v1/chat/conversations/:id/messages   ?before=&after=&around=&limit=
 *     POST   /v1/chat/conversations/:id/messages   clientId replays answer 200
 *     POST   /v1/chat/conversations/:id/read       PUT …/reactions  PUT …/notify
 *     GET    /v1/chat/search              substring, scoped like the service
 *     POST   /v1/chat/files               PUT|GET|HEAD /v1/chat/files/:id/content
 *     GET    /v1/chat/settings            PATCH /v1/chat/settings
 *                                         the two privacy switches are
 *                                         reciprocal: hiding read receipts
 *                                         hides everybody's, hiding typing
 *                                         stops the cast's typing frames.
 *                                         A refusal names its cause in
 *                                         error.details.reason. chat.* frames
 *                                         reach only a socket that sent
 *                                         X-JKNet-Features: chat
 *
 * The cast answers in chat: a message to Kyle, Jan or a group is read, typed
 * at and answered a moment later. The seeded conversations include one with
 * a deleted account (read-only, `senderId: null`) and the chat of Jan's
 * private server, which the account joins through the `selected` policy.
 *
 * The `hosting` object of a private server (TASK-41) passes through the way
 * the service passes it: `PUT /v1/presence` keeps the host's whole object
 * and `GET /v1/me` answers it back; a friend's presence reaches this
 * account as the service's view for it — no `joinUserIds`, `canJoin` set,
 * the password only where `canJoin` is true. Jan hosts one and lets this
 * account in through the `selected` policy. An invite keeps its `hosting`
 * whole, password included: it goes to one friend.
 *
 * Five routes are deliberately outside the contract, all marked below:
 * `POST /v1/dev/token` hands out a token without the browser round trip, and
 * `POST /v1/dev/invite` makes an invitation arrive on demand; with
 * `?hosting=1` or `{ "hosting": true }` the invitation leads to a private
 * server and carries its `hosting`. `POST /v1/dev/chat` makes a member of
 * the cast post `{ conversationId?, body?, mention?, cards? }` (Kyle's direct
 * conversation by default; `cards: "all"` posts one message per card kind),
 * `GET /v1/dev/chat/typing` lists the typing
 * frames the launcher sent, and `POST /v1/dev/chat/files/:id/lose` drops the
 * bytes of a chat file, so its download answers `404 file_gone`.
 *
 * Environment:
 *
 *     PORT                  8787       where to listen
 *     MOCK_ONLINE_PROVIDERS    dev        providers that may open a session
 *     MOCK_ONLINE_DEV_DELAY_MS 3000       how long a dev session stays pending
 *                                      when no browser opens its form
 *     MOCK_ONLINE_TAKEN_NAME   Taken      display name that answers 409
 *     MOCK_ONLINE_ADMIN        1          whether the account reviews bundles
 *     MOCK_ONLINE_CHAT_REPLY_MS 2500      how long the cast takes to answer in
 *                                      chat; 0 keeps the cast silent
 *
 * What it is not: it does not check the shape of what you send it beyond what
 * the launcher needs to see refused, and it has no persistence. A test that
 * needs a service to behave badly should say so here.
 *
 * No dependencies on purpose. The WebSocket handshake and framing at the end
 * are RFC 6455 by hand, and cover only what the contract uses — text frames,
 * ping, pong and close.
 */

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";

const PORT = Number(argOrEnv("--port", "PORT", "8787"));
const HOST = "127.0.0.1";
const PROVIDERS = (process.env.MOCK_ONLINE_PROVIDERS ?? "dev")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const DEV_DELAY_MS = Number(process.env.MOCK_ONLINE_DEV_DELAY_MS ?? "3000");
const TAKEN_NAME = process.env.MOCK_ONLINE_TAKEN_NAME ?? "Taken";
const ADMIN = (process.env.MOCK_ONLINE_ADMIN ?? "1") !== "0";

/** Every provider of the contract, so an unknown one is a 400 and not a 503. */
const KNOWN_PROVIDERS = ["jkhub", "discord", "dev"];

/** The service pings this often, and moves a friend around on the same beat. */
const PING_INTERVAL_MS = 20_000;
/** How long after a connection the scripted invite arrives. */
const INVITE_DELAY_MS = 40_000;
/** A client that misses this many pongs is dropped, as in the contract. */
const MISSED_PONGS_ALLOWED = 3;

/** Sign-in sessions by id. A session lives ten minutes, as in the contract. */
const sessions = new Map();
/** Session id by the `state` its dev form carries, as on the real service. */
const states = new Map();
/** The one account this service has, created by the first completed sign-in. */
let account = null;
/** The token of that account. Cleared by a logout or a delete. */
let token = null;
/** Where the launcher last said the player was. */
let presence = offline();

/** The friends, requests and invites of that account. Seeded at sign-in,
 *  because two of the entries name the account as one of their two sides. */
const world = { friends: [], incoming: [], outgoing: [], invites: [] };

// ---------------------------------------------------------------------------
// The little world the mock lives in
// ---------------------------------------------------------------------------

const person = (displayName, provider, providerName) => ({
  id: id(),
  displayName,
  avatarUrl: null,
  provider,
  providerName,
  createdAt: "2026-01-01T00:00:00Z",
});

/** The two servers the scripted friend moves between. */
const SERVERS = [
  { serverAddress: "203.0.113.10:29070", serverName: "EU FFA Nightly" },
  { serverAddress: "198.51.100.7:29071", serverName: "JA+ Duel Arena" },
];

let cast = null;

/** Fills the lists with three friends in the three states the screen groups
 *  by, one request in each direction, and no invites. */
function seedWorld() {
  cast = {
    kyle: person("Kyle Katarn", "jkhub", "kyle_k"),
    jan: person("Jan Ors", "discord", "jan_ors"),
    mara: person("Mara Jade", "jkhub", "mara_j"),
    luke: person("Luke Skywalker", "jkhub", "luke_s"),
    dash: person("Dash Rendar", "discord", "dash_r"),
  };
  world.friends = [
    {
      user: cast.kyle,
      presence: {
        status: "in_game",
        ...SERVERS[0],
        clientName: "Everyday",
        since: later(-15 * 60_000),
      },
      friendsSince: "2026-03-04T12:00:00Z",
    },
    {
      user: cast.jan,
      presence: {
        status: "online",
        serverAddress: null,
        serverName: null,
        clientName: "Duel japro",
        since: later(-3 * 60_000),
        // --- slice: play with friends --- Jan hosts a private server and
        // lets this account in through the `selected` policy.
        hosting: privateServer("selected", [account.id]),
      },
      friendsSince: "2026-04-19T09:30:00Z",
    },
    {
      user: cast.mara,
      presence: { ...offline(), since: later(-26 * 60 * 60_000) },
      friendsSince: "2025-12-24T22:10:00Z",
    },
  ];
  world.incoming = [
    { id: id(), from: cast.luke, to: account, createdAt: later(-40 * 60_000) },
  ];
  world.outgoing = [
    { id: id(), from: account, to: cast.dash, createdAt: later(-2 * 60_000) },
  ];
  world.invites = [];
  // --- slice: chat ---
  seedChat();
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  // A file upload is bytes, not JSON: a bundle file, or a chat file.
  const raw =
    request.method === "PUT" &&
    (url.pathname.startsWith("/v1/blobs/") || /^\/v1\/chat\/files\/[^/]+\/content$/.test(url.pathname));
  readBody(request, raw)
    .then((body) => route(request, response, url, body))
    .catch((e) => {
      // A mock that throws should say so on the console rather than hang the
      // launcher that is waiting for it.
      console.error(`mock-online: ${e instanceof Error ? e.stack : e}`);
      send(response, 500, { error: { code: "internal", message: String(e) } });
    });
});

server.listen(PORT, HOST, () => {
  console.log(`mock-online listening on http://${HOST}:${PORT}`);
  console.log(`  providers: ${PROVIDERS.join(", ") || "(none)"}`);
  console.log(`  a dev sign-in completes after ${DEV_DELAY_MS} ms`);
  console.log(`  a ping every ${PING_INTERVAL_MS / 1000} s, an invite after ${INVITE_DELAY_MS / 1000} s`);
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function route(request, response, url, body) {
  const method = request.method ?? "GET";
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (method === "OPTIONS") {
    response.writeHead(204, CORS);
    return response.end();
  }

  if (path === "/v1/auth/login-sessions" && method === "POST") {
    return createLoginSession(response, body);
  }
  if (path.startsWith("/v1/auth/login-sessions/") && method === "GET") {
    return readLoginSession(response, path.slice("/v1/auth/login-sessions/".length));
  }
  if (path === "/v1/auth/dev/start" && method === "GET") {
    return devStart(response, url.searchParams.get("session"));
  }
  if (path === "/v1/auth/dev/callback" && method === "GET") {
    return devCallback(
      response,
      url.searchParams.get("state"),
      url.searchParams.get("name"),
    );
  }
  if (path === "/v1/auth/logout" && method === "POST") {
    return withAuth(request, response, () => {
      token = null;
      presence = offline();
      return send(response, 204, null);
    });
  }

  // Not in the contract: a shortcut so a developer previewing the frontend in
  // a browser can have a token without the whole round trip through one.
  if (path === "/v1/dev/token" && method === "POST") {
    if (!account) complete(newSession("dev"), "Dev Player");
    return send(response, 200, { token, user: account });
  }
  // Also not in the contract. The scripted invitation arrives 40 s after a
  // socket connects, which is a long time to sit and look at a toast that has
  // not appeared yet.
  if (path === "/v1/dev/invite" && method === "POST") {
    return withAuth(request, response, () => {
      const withHosting = url.searchParams.get("hosting") === "1" || body?.hosting === true;
      const invite = incomingInvite(withHosting);
      world.invites.unshift(invite);
      broadcast("invite", { invite });
      return send(response, 201, invite);
    });
  }

  if (path === "/v1/me") {
    return withAuth(request, response, () => {
      if (method === "GET") return send(response, 200, { user: account, presence, admin: ADMIN });
      if (method === "PATCH") return renameAccount(response, body);
      if (method === "DELETE") {
        account = null;
        token = null;
        return send(response, 204, null);
      }
      return notFound(response);
    });
  }

  if (path === "/v1/friends" && method === "GET") {
    return withAuth(request, response, () =>
      send(response, 200, {
        friends: world.friends.map(friendView),
        incoming: world.incoming,
        outgoing: world.outgoing,
      }),
    );
  }

  if (path === "/v1/friends/requests" && method === "POST") {
    return withAuth(request, response, () => sendFriendRequest(response, body));
  }

  const acceptMatch = path.match(/^\/v1\/friends\/requests\/([^/]+)\/accept$/);
  if (acceptMatch && method === "POST") {
    return withAuth(request, response, () => {
      const friend = accept(acceptMatch[1]);
      if (!friend) return fail(response, 404, "not_found", "That request is gone.");
      broadcast("friend.accepted", { friend });
      // --- slice: chat --- a read-only conversation with them can send again.
      directStateChanged(friend.user.id);
      return send(response, 200, friend);
    });
  }

  const requestMatch = path.match(/^\/v1\/friends\/requests\/([^/]+)$/);
  if (requestMatch && method === "DELETE") {
    return withAuth(request, response, () => {
      const gone = drop(requestMatch[1]);
      if (!gone) return fail(response, 404, "not_found", "That request is gone.");
      // The real service tells the other side, and says it with `friend.removed`:
      // a declined or cancelled request is one more relationship that is not
      // there any more.
      broadcast("friend.removed", { userId: gone });
      return send(response, 204, null);
    });
  }

  const friendMatch = path.match(/^\/v1\/friends\/([^/]+)$/);
  if (friendMatch && method === "DELETE") {
    return withAuth(request, response, () => {
      const before = world.friends.length;
      world.friends = world.friends.filter(
        (friend) => friend.user.id !== friendMatch[1],
      );
      if (before === world.friends.length) {
        return fail(response, 404, "not_found", "You are not friends with them.");
      }
      broadcast("friend.removed", { userId: friendMatch[1] });
      // --- slice: chat --- the conversation with them turns read-only (D2).
      directStateChanged(friendMatch[1]);
      return send(response, 204, null);
    });
  }

  if (path === "/v1/presence" && method === "PUT") {
    return withAuth(request, response, () => {
      if (!["online", "in_game"].includes(body?.status)) {
        return fail(response, 400, "invalid", "status must be online or in_game.");
      }
      const hosting = body.hosting ?? null;
      const refused = hosting && hostingProblem(hosting);
      if (refused) return fail(response, 400, "invalid", refused);
      presence = {
        status: body.status,
        serverAddress: body.serverAddress ?? null,
        serverName: body.serverName ?? null,
        clientName: body.clientName ?? null,
        since: nowIso(),
        hosting,
      };
      const hosted = hosting ? ` hosting ${hosting.map} (${hosting.joinPolicy})` : "";
      console.log(`  presence -> ${presence.status} ${presence.serverAddress ?? ""}${hosted}`);
      return send(response, 200, presence);
    });
  }

  if (path === "/v1/invites" && method === "GET") {
    return withAuth(request, response, () => send(response, 200, world.invites));
  }

  if (path === "/v1/invites" && method === "POST") {
    return withAuth(request, response, () => {
      if (!body?.toUserId || !body?.serverAddress) {
        return fail(response, 400, "invalid", "An invite needs a friend and a server.");
      }
      const hosting = body.hosting ?? null;
      let refused = hosting ? hostingProblem(hosting) : null;
      if (hosting && !refused && ![hosting.relayAddress, ...(hosting.lanAddresses ?? [])].includes(body.serverAddress)) {
        refused = "serverAddress must be the relay address or an address of the network of the host.";
      }
      if (refused) return fail(response, 400, "invalid", refused);
      const invite = {
        id: id(),
        from: account,
        serverAddress: body.serverAddress,
        serverName: body.serverName ?? null,
        message: body.message ?? null,
        createdAt: nowIso(),
        expiresAt: later(10 * 60_000),
        hosting,
      };
      console.log(`  invite -> ${body.toUserId} at ${invite.serverAddress}`);
      return send(response, 201, invite);
    });
  }

  const inviteMatch = path.match(/^\/v1\/invites\/([^/]+)$/);
  if (inviteMatch && method === "DELETE") {
    return withAuth(request, response, () => {
      world.invites = world.invites.filter((invite) => invite.id !== inviteMatch[1]);
      return send(response, 204, null);
    });
  }

  // --- slice: play with friends --- no relay node behind this mock.
  if (path === "/v1/relay" || path.startsWith("/v1/relay/")) {
    return withAuth(request, response, () =>
      fail(response, 503, "relay_unavailable", "The mock service has no relay node."),
    );
  }

  if (path.startsWith("/v1/bundles") || path.startsWith("/v1/blobs/")) {
    return routeBundles(request, response, url, path, method, body);
  }

  // --- slice: chat ---
  if (path.startsWith("/v1/chat/")) {
    return withAuth(request, response, () => routeChat(request, response, url, path, method, body));
  }
  // Not in the contract: a member of the cast posts now, and the typing
  // frames the launcher sent so far.
  if (path === "/v1/dev/chat" && method === "POST") {
    return withAuth(request, response, () => devChatPost(response, body));
  }
  if (path === "/v1/dev/chat/typing" && method === "GET") {
    return withAuth(request, response, () => send(response, 200, { frames: typingSeen }));
  }
  // Not in the contract: a chat file loses its bytes, the way a lost volume
  // or a restored database leaves a ready row without a file on disk.
  const lostFile = /^\/v1\/dev\/chat\/files\/([^/]+)\/lose$/.exec(path);
  if (lostFile && method === "POST") {
    return withAuth(request, response, () => devChatLoseFile(response, lostFile[1]));
  }

  return notFound(response);
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

function createLoginSession(response, body) {
  const provider = String(body?.provider ?? "");
  if (!KNOWN_PROVIDERS.includes(provider)) {
    return send(response, 400, {
      error: { code: "invalid", message: `unknown provider ${provider}` },
    });
  }
  if (!PROVIDERS.includes(provider)) {
    // What the real service answers until JKHub and Discord issue OAuth clients.
    const name = provider === "jkhub" ? "JKHub" : "Discord";
    return send(response, 503, {
      error: {
        code: "provider_error",
        message: `${name} sign-in is not configured yet`,
      },
    });
  }

  const session = newSession(provider, body?.deviceName ?? null);
  console.log(`mock-online: session ${session.id} opened for ${provider}`);

  // The dev provider needs no browser: a launcher under test must not depend
  // on someone clicking a button. A browser that does open the form cancels
  // the timer, so the name typed there is the name that wins.
  if (provider === "dev") {
    session.timer = setTimeout(() => complete(session, "Dev Player"), DEV_DELAY_MS);
    session.timer.unref?.();
  }

  return send(response, 201, publicSession(session));
}

function newSession(provider, deviceName = null) {
  const session = {
    id: id(),
    provider,
    status: "pending",
    token: null,
    user: null,
    error: null,
    expiresAt: Date.now() + 10 * 60 * 1000,
    deviceName,
    tokenRead: false,
  };
  session.url = `http://${HOST}:${PORT}/v1/auth/${provider}/start?session=${session.id}`;
  sessions.set(session.id, session);
  return session;
}

function readLoginSession(response, rawId) {
  const session = sessions.get(rawId);
  if (!session) return notFound(response);
  if (session.status === "pending" && Date.now() > session.expiresAt) {
    session.status = "expired";
  }

  const answer = publicSession(session);
  // The contract hands out the token exactly once, so a second reader — a
  // launcher that polled twice at the same moment — gets the status alone.
  if (session.status === "done" && !session.tokenRead) {
    session.tokenRead = true;
    answer.token = session.token;
    answer.user = session.user;
  }
  return send(response, 200, answer);
}

/** The page the browser lands on: a form that asks for a display name.
 *
 *  The real service does the same, and its form submits to
 *  `/v1/auth/dev/callback?state=…&name=…`. The `dev` provider has no
 *  authorization code, so `name` stands where a real provider sends `code`;
 *  the launcher never sees either, it only opens the URL and polls.
 *
 *  A session already completed by the timer shows the closing page instead. */
function devStart(response, rawId) {
  const session = sessions.get(rawId);
  if (!session) return notFound(response);
  if (session.status !== "pending") return devDone(response, session);

  // A browser is here, so the form decides, not the timer.
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  session.state = session.state ?? randomBytes(24).toString("hex");
  states.set(session.state, session.id);

  return page(
    response,
    `<h1>JKNet dev sign-in</h1>` +
      `<form method="get" action="/v1/auth/dev/callback">` +
      `<input type="hidden" name="state" value="${escapeHtml(session.state)}">` +
      `<label>Display name<br><input name="name" value="Dev Player" autofocus></label> ` +
      `<button type="submit">Sign in</button></form>`,
  );
}

/** What the form submits to. A real provider would send `code` here. */
function devCallback(response, rawState, rawName) {
  const sessionId = states.get(rawState ?? "");
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) return notFound(response);

  const name = (rawName ?? "").trim() || "Dev Player";
  if (session.status === "pending") complete(session, name);
  states.delete(rawState);
  return devDone(response, session);
}

/** The page the player is left on, whichever way the session completed. */
function devDone(response, session) {
  const name = session.user?.displayName ?? "Dev Player";
  return page(
    response,
    `<h1>You can return to JKNet</h1>` +
      `<p>Signed in as ${escapeHtml(name)}. Close this tab and go back to the launcher.</p>`,
  );
}

function page(response, inner) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>JKNet</title>` +
      `<body style="font:16px system-ui;padding:3rem;background:#0B0E14;color:#E6EAF2">` +
      inner +
      `</body>`,
  );
}

function complete(session, displayName) {
  if (session.status !== "pending") return;
  const first = account === null;
  account = {
    id: account?.id ?? id(),
    displayName: account?.displayName ?? displayName,
    avatarUrl: null,
    provider: session.provider,
    providerName: displayName.toLowerCase().replace(/\s+/g, "_"),
    createdAt: account?.createdAt ?? nowIso(),
  };
  token = randomBytes(32).toString("hex");
  presence = { ...offline(), status: "online", since: nowIso() };
  if (first) seedWorld();

  session.status = "done";
  session.token = token;
  session.user = account;
  console.log(`mock-online: session ${session.id} completed as ${account.displayName}`);
}

/** A session without its secret, which is what a poll gets by default. */
function publicSession(session) {
  return {
    id: session.id,
    provider: session.provider,
    url: session.url,
    status: session.status,
    error: session.error,
  };
}

// ---------------------------------------------------------------------------
// Account, friends and invites
// ---------------------------------------------------------------------------

function renameAccount(response, body) {
  const name = String(body?.displayName ?? "").trim();
  if (name.length < 3 || name.length > 24) {
    return send(response, 400, {
      error: { code: "invalid", message: "a display name is 3 to 24 characters" },
    });
  }
  if (name.toLowerCase() === TAKEN_NAME.toLowerCase()) {
    return send(response, 409, {
      error: { code: "conflict", message: `${name} is taken` },
    });
  }
  account = { ...account, displayName: name };
  return send(response, 200, account);
}

function sendFriendRequest(response, body) {
  const query = String(body?.query ?? "").trim();
  if (!query) return fail(response, 400, "invalid", "Type a name to send a request to.");
  if (world.friends.some((friend) => matches(friend.user, query))) {
    return fail(response, 409, "conflict", `You are already friends with ${query}.`);
  }

  // The one case worth mocking properly: asking somebody who has already asked
  // you makes you friends on the spot, with a 200 instead of a 201.
  const pending = world.incoming.find((entry) => matches(entry.from, query));
  if (pending) return send(response, 200, { friend: accept(pending.id) });

  if (query.toLowerCase().includes("nobody")) {
    return fail(response, 404, "not_found", `Nobody on JKNet is called ${query}.`);
  }
  const created = {
    id: id(),
    from: account,
    to: person(query.replace(/^[a-z]+:/i, ""), "jkhub", query),
    createdAt: nowIso(),
  };
  world.outgoing.push(created);
  return send(response, 201, created);
}

/** Turns an incoming request into a friendship. */
function accept(requestId) {
  const index = world.incoming.findIndex((entry) => entry.id === requestId);
  if (index === -1) return null;
  const [entry] = world.incoming.splice(index, 1);
  const friend = {
    user: entry.from,
    presence: { ...offline(), status: "online", since: nowIso() },
    friendsSince: nowIso(),
  };
  world.friends.push(friend);
  return friend;
}

/** Drops a request from either queue and answers with the other side's id. */
function drop(requestId) {
  const incoming = world.incoming.find((entry) => entry.id === requestId);
  if (incoming) {
    world.incoming = world.incoming.filter((entry) => entry.id !== requestId);
    return incoming.from.id;
  }
  const outgoing = world.outgoing.find((entry) => entry.id === requestId);
  if (outgoing) {
    world.outgoing = world.outgoing.filter((entry) => entry.id !== requestId);
    return outgoing.to.id;
  }
  return null;
}

/** The invitation the scripted friend sends; to a private server of his own
 *  when `withHosting` is set. */
function incomingInvite(withHosting = false) {
  if (withHosting) {
    // An invite carries the password whatever the policy: it goes to one friend.
    const { joinUserIds: _unused, ...hosting } = privateServer("invite", []);
    return {
      id: id(),
      from: cast?.kyle ?? account,
      serverAddress: hosting.relayAddress,
      serverName: "Kyle's game",
      message: "Duel?",
      createdAt: nowIso(),
      expiresAt: later(10 * 60_000),
      hosting,
    };
  }
  return {
    id: id(),
    from: cast?.kyle ?? account,
    serverAddress: SERVERS[0].serverAddress,
    serverName: SERVERS[0].serverName,
    message: "Duel?",
    createdAt: nowIso(),
    expiresAt: later(10 * 60_000),
  };
}

// --- slice: play with friends ---

/** The whole `hosting` object of a private server, as the host's launcher
 *  sends it. The addresses are documentation ranges. */
function privateServer(joinPolicy, joinUserIds) {
  return {
    sessionId: "5e0b7c1f9a2d4c38",
    game: "ja",
    mod: null,
    map: "mp/ffa3",
    gametype: 0,
    players: 1,
    maxPlayers: 8,
    lanAddresses: ["192.168.1.23:29070"],
    relayAddress: "203.0.113.5:29210",
    password: "k7m2q9xa",
    joinPolicy,
    joinUserIds,
  };
}

/** A friend as this account sees them: the service's view of their `hosting`. */
function friendView(friend) {
  const hosting = friend.presence?.hosting;
  if (!hosting) return friend;
  return { ...friend, presence: { ...friend.presence, hosting: hostingFor(hosting, account?.id) } };
}

/** The view of a `hosting` object for one recipient: no `joinUserIds`,
 *  `canJoin` set, the password only where `canJoin` is true. */
function hostingFor(hosting, recipientId) {
  const { joinUserIds = [], password, ...rest } = hosting;
  const canJoin =
    hosting.joinPolicy === "friends" ||
    (hosting.joinPolicy === "selected" && joinUserIds.includes(recipientId));
  return canJoin ? { ...rest, password, canJoin } : { ...rest, canJoin };
}

/** Whether an address is `a.b.c.d:port` in a range of a local network. */
function isPrivateAddress(address) {
  const match = /^(\d+)\.(\d+)\.\d+\.\d+:\d+$/.exec(String(address));
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** The first rule of the contract a `hosting` object breaks, or `null`. */
function hostingProblem(hosting) {
  if (!/^[0-9a-f]{16}$/.test(String(hosting.sessionId))) {
    return "hosting.sessionId must be 16 hex characters.";
  }
  if (!["ja", "jo"].includes(hosting.game)) return "hosting.game must be ja or jo.";
  if (!["friends", "selected", "invite"].includes(hosting.joinPolicy)) {
    return "hosting.joinPolicy must be friends, selected or invite.";
  }
  const lan = hosting.lanAddresses ?? [];
  if (!Array.isArray(lan) || lan.length > 4 || !lan.every(isPrivateAddress)) {
    return "hosting.lanAddresses takes up to four private IPv4 addresses.";
  }
  if (hosting.password != null && !/^[A-Za-z0-9_-]{1,24}$/.test(hosting.password)) {
    return "hosting.password is up to 24 letters, digits, _ or -.";
  }
  return null;
}

/** Matches a display name, a `provider:name` or an id, as the service does. */
function matches(who, query) {
  const wanted = query.trim().toLowerCase();
  return (
    who.id.toLowerCase() === wanted ||
    who.displayName.toLowerCase() === wanted ||
    who.providerName.toLowerCase() === wanted ||
    `${who.provider}:${who.providerName}`.toLowerCase() === wanted
  );
}

function offline() {
  return {
    status: "offline",
    serverAddress: null,
    serverName: null,
    clientName: null,
    since: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

/**
 * The catalog: three published bundles for Jedi Academy — one of three
 * components on different engines, one custom engine build with executables,
 * one plain pk3 pack — and a fourth whose only version waits for review. Files
 * the manifests name as `blob` sit in `blobs`, so an install can download them.
 */
const bundles = new Map();
/** Stored files by SHA-256, the way the service keeps them on disk. */
const blobs = new Map();
/** The media type of every stored file the service recognised as a picture,
 *  by SHA-256; files that are not pictures have no entry. */
const blobTypes = new Map();
/** Bundle ids the account liked, and `bundleId:versionId` pairs it installed. */
const liked = new Set();
const installed = new Set();
const QUOTA_BYTES = 3 * 1024 * 1024 * 1024;
const MAX_BUNDLES = 30;
/** The manifest schema this mock understands: the same one as the service. */
const SCHEMA = 2;
const MAX_COMPONENTS = 8;
const MAX_FILES = 500;
const MAX_REMOVE = 200;
const MAX_CONFIGS = 20;
const MODES = ["multiplayer", "single"];
const ID_PATTERN = /^[a-z0-9-]{1,32}$/;
/** A description is Markdown of up to 32 KiB of UTF-8. */
const MAX_DESCRIPTION_BYTES = 32 * 1024;
/** A picture a description embeds: at most 2 MiB, at most 20 of them. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGES = 20;
/** The languages the launcher is translated into: the language of a bundle
 *  and the keys of its translations, as the service knows them. */
const LANGUAGES = ["en", "ru", "uk", "de", "fr", "es", "pl", "hu"];
const DEFAULT_LANGUAGE = "en";
/** Most translations a bundle carries: every language but its own. */
const MAX_TRANSLATIONS = LANGUAGES.length - 1;
/** The listing of a pk3 archive, a file of the store: at most 8 MiB. */
const MAX_LISTING_BYTES = 8 * 1024 * 1024;

const authors = {
  tray: person("Tray", "jkhub", "tray"),
  kyle: person("Kyle Katarn", "jkhub", "kyle_k"),
};

function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The media type of a picture by its first bytes, as the service reads it:
 *  PNG, JPEG, GIF87a or GIF89a, WebP (`RIFF????WEBP`); null for anything else. */
function imageType(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const six = bytes.subarray(0, 6).toString("latin1");
  if (six === "GIF87a" || six === "GIF89a") return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return null;
}

/** Puts bytes into the store the way an upload does: with the picture type
 *  the first bytes announce. Answers the hash. */
function storeBytes(bytes) {
  const sha256 = sha256Of(bytes);
  blobs.set(sha256, bytes);
  const type = imageType(bytes);
  if (type) blobTypes.set(sha256, type);
  else blobTypes.delete(sha256);
  return sha256;
}

/**
 * A small PNG built by hand, so a sample description can embed a picture
 * without a file on disk: `width` by `height` pixels of one RGB colour, 8 bits
 * per channel, one uncompressed-filter scanline per row, deflated by zlib.
 */
function pngOf(width, height, [r, g, b]) {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const at = y * stride + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The listing of a pk3 archive as the launcher writes it, put into the
 *  store; answers the `listing` field of the manifest entry. */
function seedListing(entries) {
  const document = { schema: 1, entries: entries.map(([path, size]) => ({ path, size })).sort((a, b) => a.path.localeCompare(b.path)) };
  const bytes = Buffer.from(JSON.stringify(document), "utf8");
  return { sha256: storeBytes(bytes), size: bytes.length };
}

/**
 * Every `blob:<sha256>` reference of a description: `blob:` followed by
 * exactly 64 hex digits of either case. Answers the text with those digits
 * lowercased and the distinct hashes in order of first appearance, as the
 * service does.
 */
function imageReferences(text) {
  const hashes = [];
  const normalized = text.replace(/blob:([0-9a-fA-F]{64})(?![0-9a-fA-F])/g, (_, hex) => {
    const hash = hex.toLowerCase();
    if (!hashes.includes(hash)) hashes.push(hash);
    return `blob:${hash}`;
  });
  return { text: normalized, hashes };
}

/**
 * Puts bytes into the store and describes them as a manifest file. `extra`
 * carries the optional parts of an entry: `library` of a pk3, `origin` of a
 * file changed after it came from JKHub, `replaces` of an overlay file.
 */
function seedFile(root, path, text, source = { kind: "blob" }, extra = {}) {
  const bytes = Buffer.from(text, "utf8");
  const sha256 = source.kind === "blob" ? storeBytes(bytes) : sha256Of(bytes);
  const file = { root, path, size: bytes.length, sha256, kind: kindOf(path), source };
  if (extra.library) file.library = extra.library;
  if (extra.origin) file.origin = extra.origin;
  if (extra.replaces) file.replaces = extra.replaces;
  if (extra.listing) file.listing = extra.listing;
  return file;
}

/** An overlay file that replaces one of the engine release: `replaces` names
 *  the hash and size the release ships. */
function seedReplacement(path, text, releaseText) {
  const release = Buffer.from(releaseText, "utf8");
  return seedFile("engine", path, text, { kind: "blob" }, {
    replaces: { sha256: sha256Of(release), size: release.length },
  });
}

/** A component the way the manifest carries it. */
function seedComponent({ id, label, engine, modes, fsGame = null, launchArgs = "", overlay = {}, files = [], configs = [] }) {
  return {
    id,
    label,
    engine: { engineId: engine.id, releaseTag: engine.tag ?? null },
    modes,
    fsGame,
    launchArgs,
    overlay: { files: overlay.files ?? [], remove: overlay.remove ?? [] },
    files,
    configs,
  };
}

/**
 * The translations of a bundle as the service stores them: trimmed, the
 * `blob:` references of every description lowercased, a missing field empty.
 * Answers them by language code with the pictures every description embeds.
 */
function normalizeTranslations(translations) {
  const normalized = {};
  const images = [];
  for (const [language, entry] of Object.entries(translations ?? {})) {
    const references = imageReferences(String(entry?.description ?? "").trim());
    normalized[language] = {
      name: String(entry?.name ?? "").trim(),
      summary: String(entry?.summary ?? "").trim(),
      description: references.text,
    };
    for (const hash of references.hashes) if (!images.includes(hash)) images.push(hash);
  }
  return { translations: normalized, images };
}

function seedBundle({ name, summary, description, language = DEFAULT_LANGUAGE, translations = {}, owner, components, shared = {}, tags, featured = false, likes, installs, status = "published", publishedAt }) {
  const references = imageReferences(description);
  const translated = normalizeTranslations(translations);
  const bundle = {
    id: id(),
    slug: slugify(name),
    name,
    summary,
    description: references.text,
    /** The language of the three fields above. */
    language,
    /** The same fields in other languages: the service's `bundle_translations`. */
    translations: translated.translations,
    /** The pictures the descriptions of every language embed: the
     *  service's `bundle_images`. */
    images: [...new Set([...references.hashes, ...translated.images])],
    game: "ja",
    tags,
    website: "https://example.org",
    discord: "https://discord.gg/example",
    owner,
    featured,
    hidden: false,
    likes,
    installs,
    revision: 1,
    createdAt: later(-40 * 24 * 60 * 60_000),
    updatedAt: publishedAt ?? nowIso(),
    versions: [],
  };
  const version = {
    id: id(),
    bundleId: bundle.id,
    label: "1.0",
    changelog: "First release",
    manifest: {
      schema: SCHEMA,
      game: "ja",
      components,
      shared: { files: shared.files ?? [], configs: shared.configs ?? [] },
    },
    status,
    reviewNote: null,
    reviewedAt: null,
    createdAt: later(-30 * 24 * 60 * 60_000),
    publishedAt: status === "published" ? (publishedAt ?? later(-30 * 24 * 60 * 60_000)) : null,
  };
  Object.assign(version, summarize(version.manifest));
  bundle.versions.push(version);
  bundles.set(bundle.id, bundle);
  return bundle;
}

const JAPRO_SOURCE = { kind: "jkhub", fileId: 3937, version: "1.6.5", title: "JAPro", url: "https://jkhub.org/files/file/3937-japro/" };
const JAPRO_LIBRARY = { category: "mod", displayName: "JAPro assets", entries: 1450, folders: { models: 266, sound: 879, ui: 12 }, maps: [] };

/** A 16 by 16 orange square: the picture the RUJKA description embeds. */
const RUJKA_PICTURE = storeBytes(pngOf(16, 16, [0xe0, 0x7a, 0x1f]));

/** What `base/zzz_rujka.pk3` holds, the way the launcher lists an archive. */
const RUJKA_EXTRAS_LISTING = seedListing([
  ["gfx/2d/crosshaira.tga", 4140],
  ["gfx/2d/crosshairb.tga", 4140],
  ["gfx/hud/rujka_logo.png", 2318],
  ["gfx/menus/rujka_background.jpg", 118_204],
  ["models/players/kyle/icon_rujka.jpg", 6021],
  ["models/players/kyle/model_rujka.skin", 1184],
  ["models/weapons2/saber_rujka/saber_w.glm", 15_940],
  ["models/weapons2/saber_rujka/saber_w.md3", 3532],
  ["models/weapons2/saber_rujka/saber.skin", 96],
  ["shaders/rujka.shader", 812],
  ["sound/chars/kyle/misc/taunt_ru.mp3", 20_112],
  ["strings/russian/rujka.str", 14_772],
]);

// The RUJKA sample is written in Russian and carries an English translation,
// so the catalog shows the fallback and the language switch of the dialog.
seedBundle({
  language: "ru",
  name: "Сборка RUJKA",
  summary: "EternalJK для серверов, OpenJK для кампании, jaMME для демок, всё по-русски.",
  description: [
    "# Сборка RUJKA",
    "",
    "Пакет RUJKA как три клиента, каждый ставится отдельным клиентом:",
    "",
    "- **EternalJK** со сборкой RUJKA и биндами для серверов",
    "- **OpenJK** для одиночной кампании по-русски",
    "- **jaMME** для записи демок",
    "",
    "Файлы pk3 с переводом общие для всех компонентов.",
    "",
    `![Логотип RUJKA](blob:${RUJKA_PICTURE})`,
    "",
    "Короткая экскурсия по серверам:",
    "",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "",
    "О проблемах пишите в [Discord RUJKA](https://discord.gg/example).",
  ].join("\n"),
  translations: {
    en: {
      name: "JKA RUJKA Edition",
      summary: "EternalJK for servers, OpenJK for the campaign, jaMME for demos, all in Russian.",
      description: [
        "# JKA RUJKA Edition",
        "",
        "The RUJKA pack as three clients, each installed as a client of its own:",
        "",
        "- **EternalJK** with the RUJKA build and the binds for the servers",
        "- **OpenJK** for the single-player campaign in Russian",
        "- **jaMME** for recording demos",
        "",
        "The translation pk3 files are shared by every component.",
        "",
        `![The RUJKA logo](blob:${RUJKA_PICTURE})`,
        "",
        "A short tour of the pack on the servers:",
        "",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "",
        "Report problems on the [RUJKA Discord](https://discord.gg/example).",
      ].join("\n"),
    },
  },
  owner: authors.tray,
  components: [
    seedComponent({
      id: "eternaljk",
      label: "Multiplayer",
      engine: { id: "eternaljk", tag: "v1.6.3" },
      modes: ["multiplayer"],
      fsGame: "eternaljk",
      launchArgs: "+set cg_fov 97",
      overlay: {
        files: [
          seedReplacement("eternaljk.x86.exe", "MZ eternaljk rujka build " + "e".repeat(4096), "MZ eternaljk release " + "r".repeat(4096)),
          seedFile("engine", "README-RUJKA.txt", "RUJKA build of EternalJK: chat in Cyrillic and a wider FOV cap.\n"),
        ],
        remove: ["rd-vulkan_x86.dll"],
      },
      files: [
        seedFile("home", "eternaljk/japro-assets.pk3", "PK japro assets", JAPRO_SOURCE, { library: JAPRO_LIBRARY }),
        seedFile("home", "eternaljk/zz_rujka_binds.cfg", "bind PGDN toggle cg_dismember 0 3\nbind F5 say_team Go!\n"),
      ],
      configs: [{ name: "RUJKA binds", text: "bind PGDN toggle cg_dismember 0 3\n", priority: 0 }],
    }),
    seedComponent({
      id: "openjk",
      label: "Single player",
      engine: { id: "openjk", tag: null },
      modes: ["single"],
      files: [seedFile("home", "base/autoexec_sp.cfg", "seta g_subtitles 1\nseta s_language russian\n")],
    }),
    seedComponent({
      id: "jamme",
      label: "Demos",
      engine: { id: "jamme", tag: "v1.9" },
      modes: ["multiplayer"],
      fsGame: "mme",
      launchArgs: "+set mme_saveWav 1",
      files: [seedFile("home", "mme/capture.cfg", "seta mme_captureFPS 60\n")],
      configs: [{ name: "Capture", text: "seta mme_captureFPS 60\n", priority: 0 }],
    }),
  ],
  shared: {
    files: [
      seedFile("home", "base/rus_sp.pk3", "PK russian translation " + "r".repeat(2048), { kind: "blob" }, {
        library: { category: "other", displayName: "Russian translation", entries: 3200, folders: { strings: 3000, ui: 200 }, maps: [], features: ["strings:russian", "fonts", "menu"] },
        origin: { kind: "jkhub", fileId: 1201, sha256: sha256Of(Buffer.from("PK russian translation as published on JKHub")), modified: true },
      }),
      seedFile("home", "base/zzz_rujka.pk3", "PK rujka extras " + "z".repeat(1024), { kind: "blob" }, {
        library: { category: "mod", displayName: "RUJKA extras", entries: 12, folders: { gfx: 4, models: 5, shaders: 1, sound: 1, strings: 1 }, maps: [], features: ["levelshots", "splash", "strings:russian", "shaders", "textures"] },
        listing: RUJKA_EXTRAS_LISTING,
      }),
    ],
    configs: [{ name: "RUJKA common", text: "seta cg_drawFPS 1\n", priority: 10 }],
  },
  tags: ["rujka", "russian", "singleplayer"],
  featured: true,
  likes: 21,
  installs: 64,
  publishedAt: later(-25 * 24 * 60 * 60_000),
});

// English only: the catalog shows it as it is in every language.
seedBundle({
  language: "en",
  name: "Taystjka VoIP 2026",
  summary: "TaystJK with voice chat, JAPro assets and tournament binds.",
  description: "A custom TaystJK build with VoIP enabled, the JAPro assets from JKHub and a set of binds for duels. Install it, pick a nickname and you are ready for the EU servers.",
  translations: {},
  owner: authors.tray,
  components: [
    seedComponent({
      id: "taystjk",
      label: "TaystJK VoIP",
      engine: { id: "taystjk", tag: "v1.6.3" },
      modes: ["multiplayer"],
      fsGame: "taystjk",
      launchArgs: "+set cg_fov 97 +set r_mode -1",
      overlay: {
        files: [
          seedReplacement("taystjk.x86_64.exe", "MZ taystjk voip build " + "x".repeat(4096), "MZ taystjk release " + "t".repeat(4096)),
          seedReplacement("rd-vanilla_x86_64.dll", "MZ renderer voip " + "v".repeat(2048), "MZ renderer release " + "d".repeat(2048)),
        ],
      },
      files: [
        seedFile("home", "taystjk/cgamex86_64.dll", "MZ cgame " + "c".repeat(2048)),
        seedFile("home", "taystjk/uix86_64.dll", "MZ ui " + "u".repeat(2048)),
        seedFile("home", "taystjk/japro-assets.pk3", "PK japro assets", JAPRO_SOURCE, { library: JAPRO_LIBRARY }),
        seedFile("home", "taystjk/binds.cfg", "bind PGDN toggle cg_dismember 0 3\nbind F5 say_team Go!\n"),
      ],
      configs: [{ name: "Tournament binds", text: "bind PGDN toggle cg_dismember 0 3\n", priority: 0 }],
    }),
  ],
  tags: ["voip", "duel", "japro"],
  likes: 12,
  installs: 48,
  publishedAt: later(-20 * 24 * 60 * 60_000),
});

seedBundle({
  name: "Everyday OpenJK",
  summary: "Plain OpenJK with a few skins and a clean HUD.",
  description: "OpenJK as shipped, plus two pk3 files: a skin pack and a HUD without the clutter. No executables, so it installs without a review; the client plays both multiplayer and the campaign.",
  owner: authors.kyle,
  components: [
    seedComponent({
      id: "openjk",
      label: "OpenJK",
      engine: { id: "openjk", tag: null },
      modes: ["multiplayer", "single"],
      files: [
        seedFile("home", "base/zz_skinpack.pk3", "PK skin pack " + "s".repeat(1024), { kind: "blob" }, {
          library: { category: "skin", displayName: "Skin pack", entries: 120, folders: { models: 100, shaders: 20 }, maps: [] },
        }),
        seedFile("home", "base/zz_cleanhud.pk3", "PK clean hud " + "h".repeat(512), { kind: "blob" }, {
          library: { category: "hud", displayName: "Clean HUD", entries: 30, folders: { gfx: 30 }, maps: [] },
        }),
      ],
    }),
  ],
  tags: ["ffa", "skins"],
  likes: 5,
  installs: 20,
  publishedAt: later(-10 * 24 * 60 * 60_000),
});

seedBundle({
  name: "Custom Build Under Review",
  summary: "An engine build that waits for an administrator.",
  description: "Its only version replaces the engine executable, so it stays pending until the review queue approves it.",
  owner: authors.kyle,
  components: [
    seedComponent({
      id: "eternaljk",
      label: "EternalJK",
      engine: { id: "eternaljk", tag: "v1.6.4" },
      modes: ["multiplayer"],
      fsGame: "eternaljk",
      overlay: {
        files: [seedReplacement("eternaljk.x86.exe", "MZ eternaljk custom " + "e".repeat(2048), "MZ eternaljk release " + "r".repeat(2048))],
      },
    }),
  ],
  tags: ["custom"],
  likes: 0,
  installs: 0,
  status: "pending",
});

function routeBundles(request, response, url, path, method, body) {
  const signedIn = isSignedIn(request);

  if (path === "/v1/bundles" && method === "GET") return listBundles(response, url, signedIn);
  if (path === "/v1/bundles" && method === "POST") {
    return withAuth(request, response, () => createBundle(response, body));
  }
  if (path === "/v1/bundles/me" && method === "GET") {
    return withAuth(request, response, () => {
      const mine = [...bundles.values()].filter((bundle) => bundle.owner.id === account.id && !bundle.hidden);
      return send(response, 200, {
        bundles: mine.map((bundle) => details(bundle, true, true)),
        usedBytes: usedBytes(),
        quotaBytes: QUOTA_BYTES,
      });
    });
  }
  if (path === "/v1/bundles/admin/pending" && method === "GET") {
    return withAdmin(request, response, () => {
      const items = [];
      for (const bundle of bundles.values()) {
        for (const version of bundle.versions) {
          if (version.status === "pending") items.push({ version, bundle: card(bundle, true) });
        }
      }
      return send(response, 200, { items });
    });
  }
  const reviewMatch = path.match(/^\/v1\/bundles\/admin\/versions\/([^/]+)$/);
  if (reviewMatch && method === "POST") {
    return withAdmin(request, response, () => reviewVersion(response, reviewMatch[1], body));
  }
  const curateMatch = path.match(/^\/v1\/bundles\/admin\/([^/]+)$/);
  if (curateMatch && method === "POST") {
    return withAdmin(request, response, () => {
      const bundle = bundles.get(curateMatch[1]);
      if (!bundle) return fail(response, 404, "not_found", "Bundle not found");
      if (typeof body?.featured !== "boolean" && typeof body?.hidden !== "boolean") {
        return fail(response, 400, "invalid", "Pass featured, hidden or both");
      }
      if (typeof body.featured === "boolean") bundle.featured = body.featured;
      if (typeof body.hidden === "boolean") bundle.hidden = body.hidden;
      touch(bundle);
      return send(response, 200, details(bundle, true, true));
    });
  }

  const blobMatch = path.match(/^\/v1\/blobs\/([0-9a-f]{64})$/);
  if (blobMatch && method === "PUT") {
    return withAuth(request, response, () => uploadBlob(request, response, blobMatch[1], body));
  }
  if (blobMatch && (method === "GET" || method === "HEAD")) {
    return downloadBlob(request, response, blobMatch[1], method === "HEAD");
  }

  const bundleMatch = path.match(/^\/v1\/bundles\/([^/]+)(?:\/(.*))?$/);
  if (!bundleMatch) return notFound(response);
  const bundle = bundles.get(bundleMatch[1]);
  const rest = bundleMatch[2] ?? "";
  const manage = signedIn && bundle && (bundle.owner.id === account.id || ADMIN);
  if (!bundle || (!isPublic(bundle) && !manage)) {
    return fail(response, 404, "not_found", "Bundle not found");
  }

  if (rest === "") {
    if (method === "GET") return send(response, 200, details(bundle, signedIn, manage));
    if (method === "PUT") {
      return withAuth(request, response, () => {
        if (!manage) return fail(response, 403, "forbidden", "Only the owner can edit this bundle");
        if (body?.revision !== bundle.revision) {
          return fail(response, 409, "conflict", "The bundle changed; reload it before saving");
        }
        const error = checkFields(body);
        if (error) return fail(response, 400, "invalid", error);
        Object.assign(bundle, fields(body));
        bundle.revision += 1;
        touch(bundle);
        return send(response, 200, details(bundle, true, true));
      });
    }
    if (method === "DELETE") {
      return withAuth(request, response, () => {
        if (!manage) return fail(response, 403, "forbidden", "Only the owner can delete this bundle");
        bundle.hidden = true;
        bundle.revision += 1;
        touch(bundle);
        return send(response, 204, null);
      });
    }
    return notFound(response);
  }

  if (rest === "versions" && method === "POST") {
    return withAuth(request, response, () => {
      if (bundle.owner.id !== account.id) {
        return fail(response, 403, "forbidden", "Only the owner can add versions");
      }
      return createVersion(response, bundle, body);
    });
  }
  if (rest === "like" && (method === "PUT" || method === "DELETE")) {
    return withAuth(request, response, () => {
      const had = liked.has(bundle.id);
      if (method === "PUT" && !had) {
        liked.add(bundle.id);
        bundle.likes += 1;
      }
      if (method === "DELETE" && had) {
        liked.delete(bundle.id);
        bundle.likes = Math.max(0, bundle.likes - 1);
      }
      return send(response, 200, { likes: bundle.likes, likedByMe: liked.has(bundle.id) });
    });
  }
  if (rest === "installs" && method === "POST") {
    return withAuth(request, response, () => {
      const version = bundle.versions.find((entry) => entry.id === body?.versionId);
      if (!version || (version.status !== "published" && !manage)) {
        return fail(response, 404, "not_found", "Version not found");
      }
      const key = `${bundle.id}:${version.id}`;
      if (!installed.has(key)) {
        installed.add(key);
        bundle.installs += 1;
      }
      return send(response, 200, { installs: bundle.installs });
    });
  }

  const versionMatch = rest.match(/^versions\/([^/]+)(\/publish)?$/);
  if (!versionMatch) return notFound(response);
  const version = bundle.versions.find((entry) => entry.id === versionMatch[1]);
  if (!version || (version.status !== "published" && !manage)) {
    return fail(response, 404, "not_found", "Version not found");
  }
  if (versionMatch[2] && method === "POST") {
    return withAuth(request, response, () => publishVersion(response, bundle, version));
  }
  if (!versionMatch[2] && method === "GET") return send(response, 200, version);
  if (!versionMatch[2] && method === "DELETE") {
    return withAuth(request, response, () => {
      if (!manage) return fail(response, 403, "forbidden", "Only the owner can delete versions");
      if (!["draft", "rejected"].includes(version.status)) {
        return fail(response, 409, "conflict", "Only drafts and rejected versions can be deleted");
      }
      bundle.versions = bundle.versions.filter((entry) => entry.id !== version.id);
      return send(response, 204, null);
    });
  }
  return notFound(response);
}

function listBundles(response, url, signedIn) {
  const game = url.searchParams.get("game");
  if (!["ja", "jo"].includes(game)) return fail(response, 400, "invalid", "Pass game=ja or game=jo");
  const sort = url.searchParams.get("sort") || "popular";
  if (!["popular", "new", "installs"].includes(sort)) {
    return fail(response, 400, "invalid", "sort must be popular, new or installs");
  }
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const engine = (url.searchParams.get("engine") ?? "").trim();
  const tag = (url.searchParams.get("tag") ?? "").trim().toLowerCase();
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);

  // The engine filter matches any component, as the service's
  // `bundle_version_engines` table does. The search reads the name and the
  // summary in every language and the tags; a bundle is one card however
  // many of its languages match. `toLowerCase()` folds every alphabet, as
  // the service does in Rust for its `search_text` column: a Cyrillic word
  // is found in either case.
  const cards = [...bundles.values()]
    .filter((bundle) => bundle.game === game && isPublic(bundle))
    .map((bundle) => card(bundle, signedIn))
    .filter((entry) => !engine || entry.components.some((component) => component.engineId === engine))
    .filter((entry) => !tag || entry.tags.includes(tag))
    .filter(
      (entry) =>
        !q ||
        entry.name.toLowerCase().includes(q) ||
        entry.summary.toLowerCase().includes(q) ||
        entry.tags.some((t) => t.includes(q)) ||
        Object.values(entry.translations).some(
          (translation) => translation.name.toLowerCase().includes(q) || translation.summary.toLowerCase().includes(q),
        ),
    );
  const by = {
    popular: (a, b) => b.likes - a.likes || b.installs - a.installs || b.publishedAt.localeCompare(a.publishedAt),
    new: (a, b) => b.publishedAt.localeCompare(a.publishedAt),
    installs: (a, b) => b.installs - a.installs || b.likes - a.likes || b.publishedAt.localeCompare(a.publishedAt),
  };
  cards.sort(by[sort]);
  return send(response, 200, { items: cards.slice(offset, offset + limit), total: cards.length });
}

function createBundle(response, body) {
  const error = checkFields(body);
  if (error) return fail(response, 400, "invalid", error);
  const mine = [...bundles.values()].filter((bundle) => bundle.owner.id === account.id && !bundle.hidden);
  if (mine.length >= MAX_BUNDLES) {
    return fail(response, 400, "invalid", `An account can publish up to ${MAX_BUNDLES} bundles`);
  }
  const base = slugify(body.name);
  let slug = base;
  for (let n = 2; [...bundles.values()].some((bundle) => bundle.slug === slug); n += 1) slug = `${base}-${n}`;
  const bundle = {
    id: id(),
    slug,
    ...fields(body),
    owner: { ...account },
    featured: false,
    hidden: false,
    likes: 0,
    installs: 0,
    revision: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    versions: [],
  };
  bundles.set(bundle.id, bundle);
  return send(response, 201, details(bundle, true, true));
}

function createVersion(response, bundle, body) {
  const error = checkManifest(body?.manifest, bundle);
  if (error) return fail(response, 400, "invalid", error);
  const version = {
    id: id(),
    bundleId: bundle.id,
    label: String(body?.label ?? "").slice(0, 32),
    changelog: String(body?.changelog ?? "").slice(0, 4000),
    manifest: normalizeManifest(body.manifest),
    status: "draft",
    reviewNote: null,
    reviewedAt: null,
    createdAt: nowIso(),
    publishedAt: null,
  };
  Object.assign(version, summarize(version.manifest));
  bundle.versions.unshift(version);
  console.log(`  bundle ${bundle.slug}: version ${version.id} drafted, ${missingBlobs(version).length} file(s) to upload`);
  return send(response, 201, { version, missingBlobs: missingBlobs(version) });
}

function publishVersion(response, bundle, version) {
  if (bundle.owner.id !== account.id) {
    return fail(response, 403, "forbidden", "Only the owner can publish versions");
  }
  if (version.status !== "draft") {
    return fail(response, 409, "conflict", `A version with status '${version.status}' cannot be published`);
  }
  const missing = missingBlobs(version);
  if (missing.length > 0) {
    return send(response, 409, {
      error: { code: "conflict", message: `${missing.length} of the files are not uploaded yet`, details: { missingBlobs: missing } },
    });
  }
  // The service recounts the columns from the store and the manifest here.
  Object.assign(version, summarize(version.manifest));
  version.status = version.hasExecutables && !ADMIN ? "pending" : "published";
  version.publishedAt = version.status === "published" ? nowIso() : null;
  touch(bundle);
  console.log(`  bundle ${bundle.slug}: version ${version.id} is ${version.status}`);
  return send(response, 200, version);
}

function reviewVersion(response, versionId, body) {
  for (const bundle of bundles.values()) {
    const version = bundle.versions.find((entry) => entry.id === versionId);
    if (!version) continue;
    if (version.status !== "pending") return fail(response, 409, "conflict", "This version is not pending review");
    version.reviewedAt = nowIso();
    version.reviewNote = body?.note ? String(body.note).slice(0, 1000) : null;
    if (body?.approve === true) {
      version.status = "published";
      version.publishedAt = nowIso();
    } else {
      version.status = "rejected";
    }
    touch(bundle);
    return send(response, 200, version);
  }
  return fail(response, 404, "not_found", "Version not found");
}

function uploadBlob(request, response, sha256, bytes) {
  const length = Number(request.headers["content-length"]);
  if (!Number.isFinite(length)) return fail(response, 400, "invalid", "Content-Length is required");
  if (blobs.has(sha256)) return send(response, 200, { sha256, size: blobs.get(sha256).length });
  const digest = sha256Of(bytes);
  if (digest !== sha256 || bytes.length !== length) {
    return fail(response, 400, "invalid", "The SHA-256 of the body does not match the path");
  }
  storeBytes(bytes);
  console.log(`  blob ${sha256.slice(0, 12)}… stored, ${bytes.length} bytes${blobTypes.has(sha256) ? `, ${blobTypes.get(sha256)}` : ""}`);
  return send(response, 201, { sha256, size: bytes.length });
}

function downloadBlob(request, response, sha256, headOnly) {
  const bytes = blobs.get(sha256);
  if (!bytes) return fail(response, 404, "not_found", "File not found");
  // A picture is served with the type the upload recorded and shown inline;
  // any other file is bytes.
  const type = blobTypes.get(sha256);
  const headers = {
    "content-type": type ?? "application/octet-stream",
    "accept-ranges": "bytes",
    etag: `"${sha256}"`,
    "cache-control": "no-store",
    ...CORS,
  };
  if (type) headers["content-disposition"] = "inline";
  let start = 0;
  let end = bytes.length - 1;
  let status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), end) : end;
    } else {
      start = Math.max(0, bytes.length - Number(range[2]));
    }
    if (start >= bytes.length || start > end) {
      response.writeHead(416, { ...headers, "content-range": `bytes */${bytes.length}` });
      return response.end();
    }
    status = 206;
    headers["content-range"] = `bytes ${start}-${end}/${bytes.length}`;
  }
  const slice = bytes.subarray(start, end + 1);
  headers["content-length"] = slice.length;
  response.writeHead(status, headers);
  return response.end(headOnly ? undefined : slice);
}

/** A bundle is in the catalog once it is not hidden and has a published version. */
function isPublic(bundle) {
  return !bundle.hidden && latestPublished(bundle) !== null;
}

function latestPublished(bundle) {
  const published = bundle.versions.filter((version) => version.status === "published");
  published.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return published[0] ?? null;
}

function card(bundle, signedIn) {
  const latest = latestPublished(bundle);
  const entry = {
    id: bundle.id,
    slug: bundle.slug,
    name: bundle.name,
    summary: bundle.summary,
    language: bundle.language,
    // The short form: the name and the summary per language, no descriptions.
    translations: Object.fromEntries(
      Object.entries(bundle.translations).map(([language, { name, summary }]) => [language, { name, summary }]),
    ),
    game: bundle.game,
    engineId: latest?.engineId ?? null,
    releaseTag: latest?.releaseTag ?? null,
    components: latest?.components ?? [],
    owner: { id: bundle.owner.id, displayName: bundle.owner.displayName, avatarUrl: bundle.owner.avatarUrl },
    tags: bundle.tags,
    blobBytes: latest?.blobBytes ?? 0,
    fileCount: latest?.fileCount ?? 0,
    hasExecutables: latest?.hasExecutables ?? false,
    featured: bundle.featured,
    likes: bundle.likes,
    installs: bundle.installs,
    latestVersionId: latest?.id ?? null,
    latestLabel: latest?.label ?? null,
    publishedAt: latest?.publishedAt ?? null,
    updatedAt: bundle.updatedAt,
  };
  if (signedIn) entry.likedByMe = liked.has(bundle.id);
  return entry;
}

function details(bundle, signedIn, manage) {
  const versions = bundle.versions.filter((version) => manage || version.status === "published");
  return {
    ...card(bundle, signedIn),
    // The full form takes the place of the card's: the descriptions too.
    translations: structuredClone(bundle.translations),
    description: bundle.description,
    website: bundle.website,
    discord: bundle.discord,
    hidden: bundle.hidden,
    revision: bundle.revision,
    createdAt: bundle.createdAt,
    latest: latestPublished(bundle),
    versions: versions.map(({ manifest: _manifest, ...summary }) => summary),
  };
}

/** Every file entry of a manifest: the overlay and the files of each
 *  component, then the shared files. */
function* allFiles(manifest) {
  for (const component of manifest.components) {
    yield* component.overlay.files;
    yield* component.files;
  }
  yield* manifest.shared.files;
}

/** Every file the store must hold for a manifest, as `{ sha256, size }`: the
 *  `blob` files and the listings of pk3 archives. A hash may repeat. */
function* blobEntries(manifest) {
  for (const file of allFiles(manifest)) {
    if (file.source?.kind === "blob") yield { sha256: file.sha256, size: file.size };
    if (file.listing) yield { sha256: file.listing.sha256, size: file.listing.size };
  }
}

/** The counters the service keeps next to a manifest. The engine and the tag
 *  of the version are those of the first component. */
function summarize(manifest) {
  const seen = new Map();
  let fileCount = 0;
  let hasExecutables = false;
  for (const file of allFiles(manifest)) {
    fileCount += 1;
    if (file.kind === "exe" || file.kind === "dll") hasExecutables = true;
  }
  for (const entry of blobEntries(manifest)) seen.set(entry.sha256, entry.size);
  const first = manifest.components[0];
  return {
    engineId: first.engine.engineId,
    releaseTag: first.engine.releaseTag ?? null,
    components: manifest.components.map(describeComponent),
    fileCount,
    blobBytes: [...seen.values()].reduce((sum, size) => sum + size, 0),
    hasExecutables,
  };
}

/** One entry of `components`: what the catalog card says about a component. */
function describeComponent(component) {
  return {
    id: component.id,
    label: component.label,
    engineId: component.engine.engineId,
    releaseTag: component.engine.releaseTag ?? null,
    modes: [...component.modes],
    replaced: component.overlay.files.filter((file) => file.replaces).length,
    added: component.overlay.files.filter((file) => !file.replaces).length,
    removed: component.overlay.remove.length,
    fileCount: component.overlay.files.length + component.files.length,
  };
}

function missingBlobs(version) {
  const missing = new Map();
  for (const entry of blobEntries(version.manifest)) {
    if (!blobs.has(entry.sha256)) missing.set(entry.sha256, entry.size);
  }
  return [...missing].map(([sha256, size]) => ({ sha256, size }));
}

/** Bytes the account holds: every distinct stored file a version of one of
 *  its bundles needs or a description of one of them embeds. */
function usedBytes() {
  const seen = new Map();
  for (const bundle of bundles.values()) {
    if (bundle.owner.id !== account?.id) continue;
    for (const version of bundle.versions) {
      for (const entry of blobEntries(version.manifest)) {
        if (blobs.has(entry.sha256)) seen.set(entry.sha256, entry.size);
      }
    }
    for (const sha256 of bundle.images ?? []) {
      if (blobs.has(sha256)) seen.set(sha256, blobs.get(sha256).length);
    }
  }
  return [...seen.values()].reduce((sum, size) => sum + size, 0);
}

/**
 * The rules of a schema 2 manifest the launcher needs to see refused: the
 * schema, the components with their ids, labels, engines and modes, the roots
 * of the overlay and home files, the paths that must not repeat, the counts.
 * Answers the message of the `400 invalid`, or null for a manifest that passes.
 */
function checkManifest(manifest, bundle) {
  if (!manifest || manifest.schema !== SCHEMA) return `Manifest schema must be ${SCHEMA}`;
  if (manifest.game !== bundle.game) return "Manifest game does not match the bundle";
  const components = manifest.components;
  if (!Array.isArray(components) || components.length < 1 || components.length > MAX_COMPONENTS) {
    return `A manifest lists 1–${MAX_COMPONENTS} components`;
  }
  const shared = manifest.shared ?? {};
  const sharedFiles = shared.files ?? [];
  const sharedPaths = new Set();
  for (const file of sharedFiles) {
    const error = checkFile(file, "home", "the shared files");
    if (error) return error;
    const key = file.path.toLowerCase();
    if (sharedPaths.has(key)) return `File '${file.path}' is listed twice in the shared files`;
    sharedPaths.add(key);
  }
  if ((shared.configs ?? []).length > MAX_CONFIGS) return `The shared files may carry at most ${MAX_CONFIGS} cfg documents`;
  let total = sharedFiles.length;
  const ids = new Set();
  for (const component of components) {
    const componentId = String(component?.id ?? "");
    if (!ID_PATTERN.test(componentId)) return "A component id must match [a-z0-9-]{1,32}";
    if (ids.has(componentId)) return `Component '${componentId}' is listed twice`;
    ids.add(componentId);
    const where = `component '${componentId}'`;
    const label = String(component.label ?? "").trim();
    if (label.length < 1 || label.length > 40) return `The label of ${where} must contain 1–40 characters`;
    if (!ID_PATTERN.test(String(component.engine?.engineId ?? ""))) return `The engineId of ${where} must match [a-z0-9-]{1,32}`;
    const modes = component.modes;
    if (!Array.isArray(modes) || modes.length === 0 || modes.some((mode) => !MODES.includes(mode)) || new Set(modes).size !== modes.length) {
      return `The modes of ${where} must be a non-empty list of multiplayer and single without repeats`;
    }
    if (String(component.launchArgs ?? "").length > 2000) return `The launchArgs of ${where} exceed 2000 characters`;
    const overlayFiles = component.overlay?.files ?? [];
    const remove = component.overlay?.remove ?? [];
    for (const file of overlayFiles) {
      const error = checkFile(file, "engine", `the overlay of ${where}`);
      if (error) return error;
    }
    if (remove.length > MAX_REMOVE) return `The overlay of ${where} removes more than ${MAX_REMOVE} files`;
    for (const path of remove) {
      if (!isSafePath(path)) return `File path '${path}' in the overlay of ${where} must be a relative path with forward slashes`;
    }
    const homePaths = new Set();
    for (const file of component.files ?? []) {
      const error = checkFile(file, "home", where);
      if (error) return error;
      const key = file.path.toLowerCase();
      if (homePaths.has(key)) return `File '${file.path}' is listed twice in ${where}`;
      if (sharedPaths.has(key)) return `File '${file.path}' of ${where} is also a shared file`;
      homePaths.add(key);
    }
    if ((component.configs ?? []).length > MAX_CONFIGS) return `${where} may carry at most ${MAX_CONFIGS} cfg documents`;
    total += overlayFiles.length + (component.files ?? []).length;
  }
  if (total > MAX_FILES) return `A version may list at most ${MAX_FILES} files`;
  return null;
}

function checkFile(file, root, where) {
  if (!file || typeof file !== "object") return `A file entry in ${where} is not an object`;
  if (file.root !== root) return `File '${file.path}' in ${where} must have root ${root}`;
  if (!isSafePath(file.path)) return `File path '${file.path}' in ${where} must be a relative path with forward slashes`;
  if (!/^[0-9a-f]{64}$/.test(String(file.sha256 ?? ""))) return `File '${file.path}' needs a 64-character lowercase hex SHA-256`;
  if (!Number.isInteger(file.size) || file.size < 0) return `File '${file.path}' needs a size in bytes`;
  if (!["blob", "jkhub"].includes(file.source?.kind)) return `File '${file.path}' needs a source of kind blob or jkhub`;
  if (file.listing !== undefined && file.listing !== null) {
    // A listing is a file of the store that only a pk3 carries.
    if (kindOf(file.path) !== "pk3") return `File '${file.path}' carries a listing but is not a pk3`;
    if (!/^[0-9a-f]{64}$/.test(String(file.listing.sha256 ?? ""))) {
      return `File '${file.path}' needs a 64-character lowercase hex SHA-256 of its listing`;
    }
    if (!Number.isInteger(file.listing.size) || file.listing.size < 0 || file.listing.size > MAX_LISTING_BYTES) {
      return `The listing of file '${file.path}' exceeds the limit of ${MAX_LISTING_BYTES} bytes`;
    }
  }
  return null;
}

/** A relative path with forward slashes that stays inside its root. */
function isSafePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 260) return false;
  if (path.startsWith("/") || path.includes("\\") || /[<>:"|?*\u0000-\u001f]/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** The document the service stores: every optional part filled in and the
 *  kind of every file computed from its extension. */
function normalizeManifest(manifest) {
  const normalizeFile = (file) => {
    const entry = { root: file.root, path: file.path, size: file.size, sha256: file.sha256, kind: kindOf(file.path), source: file.source };
    if (file.library) entry.library = file.library;
    if (file.origin) entry.origin = file.origin;
    if (file.replaces) entry.replaces = file.replaces;
    if (file.listing) entry.listing = { sha256: file.listing.sha256, size: file.listing.size };
    return entry;
  };
  return {
    schema: SCHEMA,
    game: manifest.game,
    components: manifest.components.map((component) => ({
      id: component.id,
      label: String(component.label).trim(),
      engine: { engineId: component.engine.engineId, releaseTag: component.engine.releaseTag ?? null },
      modes: [...component.modes],
      fsGame: component.fsGame ?? null,
      launchArgs: component.launchArgs ?? "",
      overlay: {
        files: (component.overlay?.files ?? []).map(normalizeFile),
        remove: [...(component.overlay?.remove ?? [])],
      },
      files: (component.files ?? []).map(normalizeFile),
      configs: component.configs ?? [],
    })),
    shared: {
      files: (manifest.shared?.files ?? []).map(normalizeFile),
      configs: manifest.shared?.configs ?? [],
    },
  };
}

function kindOf(path) {
  const extension = path.toLowerCase().split("/").pop().split(".").pop();
  return ["pk3", "cfg", "dll", "exe"].includes(extension) ? extension : "other";
}

function slugify(name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return slug || "bundle";
}

function checkFields(body) {
  const name = String(body?.name ?? "").trim();
  if (name.length < 2 || name.length > 64) return "name must contain 2–64 characters";
  if (!["ja", "jo"].includes(body?.game)) return "Choose Jedi Academy or Jedi Outcast";
  const tags = body?.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 10 || tags.some((tag) => !/^[a-z0-9-]{1,24}$/.test(String(tag).trim().toLowerCase()))) {
    return "A tag is 1–24 lowercase letters, digits and hyphens";
  }
  if (String(body?.summary ?? "").length > 200) return "summary must contain 0–200 characters";
  const description = String(body?.description ?? "").trim();
  if (Buffer.byteLength(description, "utf8") > MAX_DESCRIPTION_BYTES) {
    return `description must contain at most ${MAX_DESCRIPTION_BYTES} bytes of UTF-8`;
  }
  // The language and the translations, as the service checks them: codes
  // from the launcher's list, at most seven translations, none of them the
  // main language, each field under the rules of its main counterpart or
  // empty.
  const language = String(body?.language ?? "").trim() || DEFAULT_LANGUAGE;
  if (!LANGUAGES.includes(language)) return `Unknown language '${language}'; use one of ${LANGUAGES.join(", ")}`;
  const translations = body?.translations ?? {};
  if (typeof translations !== "object" || Array.isArray(translations)) return "translations must be an object by language code";
  const entries = Object.entries(translations);
  if (entries.length > MAX_TRANSLATIONS) return `A bundle carries at most ${MAX_TRANSLATIONS} translations`;
  for (const [code, entry] of entries) {
    if (!LANGUAGES.includes(code)) return `Unknown language '${code}'; use one of ${LANGUAGES.join(", ")}`;
    if (code === language) return `'${code}' is the language of the bundle itself, not a translation`;
    const translatedName = String(entry?.name ?? "").trim();
    if (translatedName.length === 1 || translatedName.length > 64) return `translations.${code}.name must contain 2–64 characters or stay empty`;
    if (String(entry?.summary ?? "").trim().length > 200) return `translations.${code}.summary must contain 0–200 characters`;
    if (Buffer.byteLength(String(entry?.description ?? "").trim(), "utf8") > MAX_DESCRIPTION_BYTES) {
      return `translations.${code}.description must contain at most ${MAX_DESCRIPTION_BYTES} bytes of UTF-8`;
    }
  }
  // Every picture a description of any language embeds must be an uploaded
  // picture within the limits; each refusal names the hash, as the
  // service's does. The count is of distinct pictures across languages.
  const hashes = [...new Set([...imageReferences(description).hashes, ...normalizeTranslations(translations).images])];
  if (hashes.length > MAX_IMAGES) return `The description embeds ${hashes.length} pictures; at most ${MAX_IMAGES} are allowed`;
  for (const sha256 of hashes) {
    if (!blobs.has(sha256)) return `Picture blob:${sha256} is not uploaded`;
    if (!blobTypes.has(sha256)) return `File blob:${sha256} is not a picture`;
    const size = blobs.get(sha256).length;
    if (size > MAX_IMAGE_BYTES) return `Picture blob:${sha256} is ${size} bytes, more than the limit of ${MAX_IMAGE_BYTES}`;
  }
  for (const link of [body?.website, body?.discord]) {
    if (link && !String(link).startsWith("https://")) return "Use an HTTPS link";
  }
  return null;
}

function fields(body) {
  const references = imageReferences(String(body.description ?? "").trim());
  const translated = normalizeTranslations(body.translations ?? {});
  return {
    name: String(body.name).trim(),
    summary: String(body.summary ?? "").trim(),
    description: references.text,
    language: String(body.language ?? "").trim() || DEFAULT_LANGUAGE,
    // The set the request carries is the whole set: a `PUT` without
    // translations leaves none.
    translations: translated.translations,
    images: [...new Set([...references.hashes, ...translated.images])],
    game: body.game,
    tags: [...new Set((body.tags ?? []).map((tag) => String(tag).trim().toLowerCase()))],
    website: String(body.website ?? "").trim(),
    discord: String(body.discord ?? "").trim(),
  };
}

function touch(bundle) {
  bundle.updatedAt = nowIso();
}

/** True when the request carries the account's token. */
function isSignedIn(request) {
  const header = request.headers.authorization ?? "";
  return Boolean(token) && header === `Bearer ${token}` && account !== null;
}

function withAdmin(request, response, handler) {
  return withAuth(request, response, () => {
    if (!ADMIN) return fail(response, 403, "forbidden", "Administrator access required");
    return handler();
  });
}

// ---------------------------------------------------------------------------
// --- slice: chat ---
// Chat
// ---------------------------------------------------------------------------

/**
 * The chat of this account with the cast. The cast are not accounts, so the
 * mock plays them: a message of the account in a conversation with one of
 * them is read, typed at and answered a moment later, within the account's
 * privacy settings. `chat.*` frames reach only a socket that sent
 * `X-JKNet-Features: chat`, as on the service.
 *
 * Seeded at sign-in: a direct conversation with Kyle (one unread), one with
 * Jan carrying a card of his private server, the group "Saber school" owned
 * by Kyle with a message and a reply of a deleted account and a mention of
 * this account, a read-only conversation with a deleted account, the chat of
 * Jan's private server (not joined; join it with his id as `hostUserId`),
 * and an invite into Mara's group "Night raid". Mara asks before she is
 * added to a group, so adding her makes an invite.
 */
const CHAT_MAX_BODY_CHARS = 4000;
const CHAT_MAX_CARDS = 5;
const CHAT_MAX_FILES = 10;
const CHAT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const CHAT_QUOTA_BYTES = 1024 * 1024 * 1024;
const CHAT_GROUP_MAX_MEMBERS = 20;
const CHAT_CARD_TYPES = ["server", "hostInvite", "bundle", "jkhubMod", "map", "profile", "bind", "config"];
const CHAT_EXECUTABLE_EXTENSIONS = new Set(
  "exe com scr bat cmd ps1 psm1 vbs vbe js jse wsf wsh hta msi msp msix appx lnk url pif cpl dll sys inf reg jar scf chm iso img vhd vhdx application gadget xll docm xlsm pptm".split(" "),
);
/** How long the cast takes to answer; `0` turns the answers off. */
const CHAT_REPLY_MS = Number(process.env.MOCK_ONLINE_CHAT_REPLY_MS ?? "2500");
const CHAT_REPLIES = ["gg", "On my way", "Duel after this round?", "Nice one 👍", "brb, reloading the map"];

/** Conversations by id; `members` is a Map by user id, `messages` in seq order. */
const chats = new Map();
/** Chat files by id, their bytes kept in memory. */
const chatFiles = new Map();
/** Group invites addressed to this account. */
let groupInvites = [];
/** The account's chat settings: both privacy switches are reciprocal. */
let chatSettings = defaultChatSettings();
/** A global counter standing in for `chat_messages.pk`: the search cursor. */
let chatPk = 0;
/** An account that was deleted: its id survives only in old tokens. */
let deletedId = null;
/** The `chat.typing` frames the launcher sent, for `GET /v1/dev/chat/typing`. */
const typingSeen = [];

function defaultChatSettings() {
  return { shareReadReceipts: true, shareTyping: true, groupAdd: "friends" };
}

/** Everyone the mock can name: the account and the cast. */
function userById(userId) {
  if (account && account.id === userId) return account;
  const known = [...Object.values(cast ?? {}), ...world.outgoing.map((request) => request.to)];
  return known.find((user) => user.id === userId) ?? null;
}

function isFriend(userId) {
  return world.friends.some((friend) => friend.user.id === userId);
}

/** Only Mara asks before she is added to a group. */
function asksBeforeAdding(userId) {
  return cast && userId === cast.mara.id;
}

function newConversation(kind, { ownerId = null, title = null, peerId = null, server = null, createClientId = null, createdAt = nowIso() } = {}) {
  const conversation = {
    id: id(),
    kind,
    title,
    ownerId,
    peerId,
    server,
    createClientId,
    historyForNewMembers: false,
    lastSeq: 0,
    lastMessageAt: null,
    createdAt,
    members: new Map(),
    messages: [],
  };
  chats.set(conversation.id, conversation);
  return conversation;
}

function addMember(conversation, userId, { role = "member", visibleFromSeq = 0, joinedAt = nowIso() } = {}) {
  conversation.members.set(userId, { userId, role, joinedAt, visibleFromSeq, readSeq: 0, notify: "all" });
}

/** Stores one message and answers it. `senderId: null` is a system message,
 *  or, with `kind: "user"`, a message of a deleted account. */
function post(conversation, senderId, body, { kind = "user", cards = [], fileIds = [], replySeq = null, system = null, clientId = null, at = nowIso() } = {}) {
  const seq = ++conversation.lastSeq;
  const mentions = new Set();
  for (const [, userId] of String(body).matchAll(/<@([0-9A-Za-z]+)>/g)) {
    if (conversation.members.has(userId) && userId !== senderId) mentions.add(userId);
  }
  const replied = replySeq == null ? null : conversation.messages.find((message) => message.seq === replySeq);
  if (replied?.senderId && replied.senderId !== senderId && conversation.members.has(replied.senderId)) {
    mentions.add(replied.senderId);
  }
  const message = {
    pk: ++chatPk,
    seq,
    senderId,
    clientId,
    kind,
    body,
    cards,
    fileIds,
    mentions: [...mentions],
    replySeq: replied ? replySeq : null,
    reactions: new Map(),
    system,
    createdAt: at,
  };
  conversation.messages.push(message);
  conversation.lastMessageAt = at;
  for (const fileId of fileIds) {
    const file = chatFiles.get(fileId);
    if (file) file.messageSeq = seq;
  }
  const author = senderId && conversation.members.get(senderId);
  if (author) author.readSeq = seq;
  return message;
}

function systemPost(conversation, event, fields = {}) {
  return post(conversation, null, "", { kind: "system", system: { event, ...fields } });
}

function seedChat() {
  chats.clear();
  chatFiles.clear();
  groupInvites = [];
  chatSettings = defaultChatSettings();
  chatPk = 0;
  typingSeen.length = 0;
  deletedId = id();
  const me = account.id;
  const minutesAgo = (minutes) => later(-minutes * 60_000);

  const kyle = newConversation("direct", { peerId: cast.kyle.id, createdAt: minutesAgo(90) });
  addMember(kyle, me);
  addMember(kyle, cast.kyle.id);
  post(kyle, cast.kyle.id, "Duel on ffa3 tonight?", { at: minutesAgo(50) });
  post(kyle, me, "Sure, after nine", { at: minutesAgo(48) });
  post(kyle, cast.kyle.id, "Bring your best saber stance 😄", { at: minutesAgo(5) });
  kyle.members.get(me).readSeq = 2;
  kyle.members.get(cast.kyle.id).readSeq = 3;

  const jan = newConversation("direct", { peerId: cast.jan.id, createdAt: minutesAgo(30) });
  addMember(jan, me);
  addMember(jan, cast.jan.id);
  const janServer = privateServer("selected", [me]);
  post(jan, cast.jan.id, "My server is up, come in", {
    at: minutesAgo(3),
    cards: [{
      type: "hostInvite",
      v: 1,
      fallbackText: "Jan's game on mp/ffa3",
      sessionId: janServer.sessionId,
      name: "Jan's game",
      hostId: cast.jan.id,
      game: janServer.game,
      map: janServer.map,
      gametype: janServer.gametype,
    }],
  });

  const school = newConversation("group", { ownerId: cast.kyle.id, title: "Saber school", createdAt: minutesAgo(240) });
  for (const userId of [cast.kyle.id, me, cast.jan.id, cast.mara.id]) {
    addMember(school, userId, { role: userId === cast.kyle.id ? "owner" : "member", joinedAt: minutesAgo(240) });
  }
  systemPost(school, "created", { by: cast.kyle.id });
  post(school, cast.kyle.id, "Welcome to saber school!", { at: minutesAgo(230) });
  const farewell = post(school, null, "I'm off for a while, thanks <@" + me + ">", { at: minutesAgo(200) });
  systemPost(school, "memberLeft", { userId: deletedId });
  post(school, cast.mara.id, "See you around!", { at: minutesAgo(190), replySeq: farewell.seq });
  const lesson = post(school, cast.jan.id, "Lesson two: the kata of <@" + deletedId + "> is still the best", { at: minutesAgo(60) });
  lesson.reactions.set("👍", new Set([cast.kyle.id, cast.mara.id]));
  post(school, cast.kyle.id, "<@" + me + "> you're up next", { at: minutesAgo(2) });
  school.members.get(me).readSeq = 3;

  const gone = newConversation("direct", { peerId: deletedId, createdAt: minutesAgo(3000) });
  addMember(gone, me);
  post(gone, null, "gg, thanks for all the games", { at: minutesAgo(2900) });
  post(gone, me, "Anytime!", { at: minutesAgo(2890) });

  const hosted = newConversation("server", {
    ownerId: cast.jan.id,
    server: { hostId: cast.jan.id, sessionId: janServer.sessionId },
    createdAt: minutesAgo(4),
  });
  addMember(hosted, cast.jan.id, { role: "owner" });
  systemPost(hosted, "serverStarted", { by: cast.jan.id });
  post(hosted, cast.jan.id, "Warming up on ffa3, the lobby is open", { at: minutesAgo(4) });

  const raid = newConversation("group", { ownerId: cast.mara.id, title: "Night raid", createdAt: minutesAgo(20) });
  addMember(raid, cast.mara.id, { role: "owner" });
  addMember(raid, cast.kyle.id);
  systemPost(raid, "created", { by: cast.mara.id });
  groupInvites = [{ conversationId: raid.id, invitedBy: cast.mara.id, createdAt: minutesAgo(15), expiresAt: later(7 * 24 * 60 * 60_000) }];
}

// -- What the account sees -------------------------------------------------

/** Rewrites tokens and ids of accounts that no longer exist, as the service's
 *  row mapper does. */
function chatText(text) {
  return String(text).replace(/<@([0-9A-Za-z]+)>/g, (token, userId) => (userById(userId) ? token : "<@deleted>"));
}

function messageWire(conversation, message) {
  const me = account.id;
  const member = conversation.members.get(me);
  let replyTo = null;
  if (message.replySeq != null) {
    const replied = conversation.messages.find((entry) => entry.seq === message.replySeq);
    replyTo = !replied || (member && replied.seq <= member.visibleFromSeq)
      ? { seq: message.replySeq, missing: true }
      : {
          seq: replied.seq,
          senderId: replied.senderId && userById(replied.senderId) ? replied.senderId : null,
          excerpt: chatText(replied.body).slice(0, 140),
        };
  }
  const system = message.system
    ? {
        ...message.system,
        userId: message.system.userId && userById(message.system.userId) ? message.system.userId : null,
        by: message.system.by && userById(message.system.by) ? message.system.by : null,
      }
    : null;
  return {
    conversationId: conversation.id,
    seq: message.seq,
    senderId: message.senderId && userById(message.senderId) ? message.senderId : null,
    clientId: message.clientId,
    kind: message.kind,
    body: chatText(message.body),
    cards: message.cards,
    files: message.fileIds.map((fileId) => chatFiles.get(fileId)).filter(Boolean).map(fileWire),
    mentions: message.mentions.filter((userId) => userById(userId)),
    replyTo,
    reactions: [...message.reactions].map(([emoji, users]) => ({ emoji, userIds: [...users] })),
    system,
    createdAt: message.createdAt,
  };
}

function fileWire(file) {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    mediaType: file.mediaType,
    class: file.class,
    danger: file.danger,
    meta: file.meta,
  };
}

function canSend(conversation) {
  if (conversation.kind !== "direct") return true;
  return Boolean(userById(conversation.peerId)) && isFriend(conversation.peerId);
}

function visibleMessages(conversation) {
  const member = conversation.members.get(account.id);
  return conversation.messages.filter((message) => message.seq > (member?.visibleFromSeq ?? 0));
}

function conversationWire(conversation) {
  const me = account.id;
  const member = conversation.members.get(me);
  const shared = chatSettings.shareReadReceipts;
  const visible = visibleMessages(conversation);
  const unreadFrom = Math.max(member.readSeq, member.visibleFromSeq);
  const unread = visible.filter((message) => message.kind === "user" && message.senderId !== me && message.seq > unreadFrom).length;
  const unreadMentions = visible.filter((message) => message.seq > unreadFrom && message.mentions.includes(me)).length;
  const last = visible[visible.length - 1];
  return {
    id: conversation.id,
    kind: conversation.kind,
    title: conversation.title,
    ownerId: conversation.ownerId && userById(conversation.ownerId) ? conversation.ownerId : null,
    members: [...conversation.members.values()]
      .filter((entry) => userById(entry.userId))
      .map((entry) => ({
        user: userById(entry.userId),
        role: entry.role,
        joinedAt: entry.joinedAt,
        // D8: another member's marker only while both share receipts; the
        // cast always shares.
        readSeq: entry.userId === me || shared ? entry.readSeq : null,
      })),
    lastSeq: conversation.lastSeq,
    lastMessage: last ? messageWire(conversation, last) : null,
    readSeq: member.readSeq,
    visibleFromSeq: member.visibleFromSeq,
    unread: Math.min(unread, 100),
    unreadMentions: Math.min(unreadMentions, 100),
    notify: member.notify,
    canSend: canSend(conversation),
    historyForNewMembers: conversation.kind === "direct" ? false : conversation.historyForNewMembers,
    server: conversation.server,
    createdAt: conversation.createdAt,
  };
}

function groupInviteWire(invite) {
  const conversation = chats.get(invite.conversationId);
  return {
    conversationId: invite.conversationId,
    title: conversation?.title ?? null,
    invitedBy: userById(invite.invitedBy),
    memberCount: conversation?.members.size ?? 0,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
  };
}

function myConversations() {
  return [...chats.values()]
    .filter((conversation) => conversation.members.has(account.id))
    .sort((a, b) => String(b.lastMessageAt ?? b.createdAt).localeCompare(String(a.lastMessageAt ?? a.createdAt)));
}

function chatQuota() {
  const usedBytes = [...chatFiles.values()]
    .filter((file) => file.uploaderId === account.id)
    .reduce((sum, file) => sum + file.size, 0);
  return { usedBytes, quotaBytes: CHAT_QUOTA_BYTES, nextFreeAt: null };
}

function syncDoc() {
  return {
    conversations: myConversations().map(conversationWire),
    groupInvites: groupInvites.map(groupInviteWire),
    settings: chatSettings,
    quota: chatQuota(),
  };
}

// -- Frames ----------------------------------------------------------------

/** Every chat frame goes to this account only: the cast has no sockets. */
const broadcastChat = (type, payload) => {
  for (const client of sockets) {
    if (client.chat) write(client.socket, frame(type, payload));
  }
};

function announceMessage(conversation, message) {
  broadcastChat("chat.message", { message: messageWire(conversation, message) });
}

function announceConversation(conversation) {
  if (conversation.members.has(account.id)) {
    broadcastChat("chat.conversation", { conversation: conversationWire(conversation) });
  }
}

/** A direct conversation reads `canSend` from the friendship; tell the
 *  launcher when that moved. */
function directStateChanged(userId) {
  for (const conversation of chats.values()) {
    if (conversation.kind === "direct" && conversation.peerId === userId) announceConversation(conversation);
  }
}

/** A member of the cast reads what the account wrote, types, and answers. */
function scriptReply(conversation, message) {
  if (CHAT_REPLY_MS <= 0) return;
  const me = account.id;
  const others = [...conversation.members.keys()].filter((userId) => userId !== me && userById(userId) && isFriend(userId));
  if (others.length === 0) return;
  const responder = conversation.kind === "direct" ? others[0] : others[Math.floor(Math.random() * others.length)];
  setTimeout(() => {
    const member = conversation.members.get(responder);
    if (!member || !chats.has(conversation.id)) return;
    member.readSeq = Math.max(member.readSeq, message.seq);
    if (chatSettings.shareReadReceipts) {
      broadcastChat("chat.read", { conversationId: conversation.id, userId: responder, seq: member.readSeq });
    }
  }, Math.min(800, CHAT_REPLY_MS / 2));
  setTimeout(() => {
    if (chatSettings.shareTyping && chats.has(conversation.id)) {
      broadcastChat("chat.typing", { conversationId: conversation.id, userId: responder, ttlMs: 6000 });
    }
  }, Math.min(1200, CHAT_REPLY_MS / 2));
  setTimeout(() => {
    if (!chats.has(conversation.id) || !conversation.members.has(responder)) return;
    let body = CHAT_REPLIES[Math.floor(Math.random() * CHAT_REPLIES.length)];
    if (conversation.kind !== "direct" && Math.random() < 0.5) body = `<@${me}> ${body}`;
    const reply = post(conversation, responder, body, { replySeq: Math.random() < 0.3 ? message.seq : null });
    announceMessage(conversation, reply);
  }, CHAT_REPLY_MS);
}

// -- Routes ----------------------------------------------------------------

function refuse(response, status, code, reason, message, extra = {}) {
  return send(response, status, { error: { code, message, details: { reason, ...extra } } });
}

function noConversation(response) {
  return fail(response, 404, "not_found", "No such conversation");
}

function routeChat(request, response, url, path, method, body) {
  const me = account.id;
  if (path === "/v1/chat/conversations" && method === "GET") return send(response, 200, syncDoc());

  const conversationMatch = path.match(/^\/v1\/chat\/conversations\/([^/]+)(?:\/(messages|read|reactions|notify))?$/);
  if (conversationMatch) {
    const conversation = chats.get(conversationMatch[1]);
    if (!conversation || !conversation.members.has(me)) return noConversation(response);
    const action = conversationMatch[2];
    if (!action && method === "GET") return send(response, 200, conversationWire(conversation));
    if (action === "messages" && method === "GET") return chatHistory(response, conversation, url);
    if (action === "messages" && method === "POST") return chatSend(response, conversation, body);
    if (action === "read" && method === "POST") return chatRead(response, conversation, body);
    if (action === "reactions" && method === "PUT") return chatReact(response, conversation, body);
    if (action === "notify" && method === "PUT") return chatNotify(response, conversation, body);
    return notFound(response);
  }

  const memberMatch = path.match(/^\/v1\/chat\/conversations\/([^/]+)\/members\/([^/]+)$/);
  if (memberMatch && method === "DELETE") return chatRemoveMember(response, memberMatch[1], memberMatch[2]);

  const directMatch = path.match(/^\/v1\/chat\/direct\/([^/]+)$/);
  if (directMatch && method === "PUT") return chatOpenDirect(response, directMatch[1]);

  if (path === "/v1/chat/groups" && method === "POST") return chatCreateGroup(response, body);
  const groupMatch = path.match(/^\/v1\/chat\/groups\/([^/]+)(?:\/(members|join))?$/);
  if (groupMatch) {
    const conversation = chats.get(groupMatch[1]);
    if (!conversation || conversation.kind !== "group") return noConversation(response);
    if (groupMatch[2] === "join" && method === "POST") return chatJoinGroup(response, conversation);
    if (!conversation.members.has(me)) return noConversation(response);
    if (!groupMatch[2] && method === "PATCH") return chatPatchGroup(response, conversation, body);
    if (groupMatch[2] === "members" && method === "POST") return chatAddMembers(response, conversation, body);
    return notFound(response);
  }
  const inviteMatch = path.match(/^\/v1\/chat\/groups\/([^/]+)\/invites\/([^/]+)$/);
  if (inviteMatch && method === "DELETE") {
    const before = groupInvites.length;
    if (inviteMatch[2] === me) {
      groupInvites = groupInvites.filter((invite) => invite.conversationId !== inviteMatch[1]);
      if (groupInvites.length !== before) broadcastChat("chat.groupInvite.removed", { conversationId: inviteMatch[1] });
      return send(response, 204, null);
    }
    const conversation = chats.get(inviteMatch[1]);
    if (!conversation || !conversation.members.has(me)) return noConversation(response);
    return send(response, 204, null);
  }

  const serverMatch = path.match(/^\/v1\/chat\/servers\/([0-9a-f]{16})(\/join)?$/);
  if (serverMatch) {
    const sessionId = serverMatch[1];
    if (serverMatch[2] && method === "POST") return chatJoinServer(response, sessionId, body);
    if (!serverMatch[2] && method === "PUT") return chatOpenServer(response, sessionId);
    if (!serverMatch[2] && method === "PATCH") return chatPatchServer(response, sessionId, body);
    if (!serverMatch[2] && method === "DELETE") {
      for (const conversation of [...chats.values()]) {
        if (conversation.kind === "server" && conversation.ownerId === me && conversation.server.sessionId === sessionId) {
          endChat(conversation, "ended");
        }
      }
      return send(response, 204, null);
    }
    return notFound(response);
  }

  if (path === "/v1/chat/search" && method === "GET") return chatSearch(response, url);

  if (path === "/v1/chat/files" && method === "POST") return chatRegisterFile(response, body);
  const fileMatch = path.match(/^\/v1\/chat\/files\/([^/]+)\/content$/);
  if (fileMatch && method === "PUT") return chatUploadFile(request, response, fileMatch[1], body);
  if (fileMatch && (method === "GET" || method === "HEAD")) {
    return chatDownloadFile(request, response, fileMatch[1], method === "HEAD");
  }

  if (path === "/v1/chat/settings" && method === "GET") return send(response, 200, chatSettings);
  if (path === "/v1/chat/settings" && method === "PATCH") {
    const next = { ...chatSettings };
    for (const key of ["shareReadReceipts", "shareTyping"]) {
      if (body?.[key] !== undefined) {
        if (typeof body[key] !== "boolean") return fail(response, 400, "invalid", `${key} must be true or false`);
        next[key] = body[key];
      }
    }
    if (body?.groupAdd !== undefined) {
      if (!["friends", "ask"].includes(body.groupAdd)) return fail(response, 400, "invalid", "groupAdd must be friends or ask");
      next.groupAdd = body.groupAdd;
    }
    chatSettings = next;
    broadcastChat("chat.settings", { settings: chatSettings });
    return send(response, 200, chatSettings);
  }

  return notFound(response);
}

function chatHistory(response, conversation, url) {
  const visible = visibleMessages(conversation);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);
  const number = (key) => (url.searchParams.has(key) ? Number(url.searchParams.get(key)) : null);
  const before = number("before");
  const after = number("after");
  const around = number("around");
  let page;
  if (around !== null) {
    const half = Math.floor(limit / 2);
    const older = visible.filter((message) => message.seq < around).slice(-half);
    const newer = visible.filter((message) => message.seq >= around).slice(0, limit - older.length);
    page = [...older, ...newer];
  } else if (before !== null) {
    page = visible.filter((message) => message.seq < before).slice(-limit);
  } else if (after !== null) {
    page = visible.filter((message) => message.seq > after).slice(0, limit);
  } else {
    page = visible.slice(-limit);
  }
  const first = page[0]?.seq ?? before ?? (after !== null ? after + 1 : Infinity);
  const last = page[page.length - 1]?.seq ?? (after ?? (before !== null ? before - 1 : -Infinity));
  return send(response, 200, {
    messages: page.map((message) => messageWire(conversation, message)),
    hasBefore: visible.some((message) => message.seq < first),
    hasAfter: visible.some((message) => message.seq > last),
  });
}

function cleanBody(text) {
  return String(text ?? "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "")
    .replace(/\n{5,}/g, "\n\n\n\n");
}

/** The card rules the launcher can meet on the service, loosely: the shape,
 *  the version, and the host of a `hostInvite`. */
function checkCard(card) {
  if (!card || typeof card !== "object" || !CHAT_CARD_TYPES.includes(card.type) || card.v !== 1) return null;
  if (JSON.stringify(card).length > 8 * 1024 && card.type !== "config") return null;
  if (card.type !== "hostInvite") return card;
  const hosting = presence.hosting;
  if (!hosting || hosting.sessionId !== card.sessionId) return null;
  // The service fills what the card may say about the server from the live
  // hosting; the password and the addresses never reach it.
  return {
    type: "hostInvite",
    v: 1,
    fallbackText: String(card.fallbackText ?? "").slice(0, 200),
    sessionId: hosting.sessionId,
    name: card.name ?? null,
    hostId: account.id,
    game: hosting.game,
    mod: hosting.mod ?? null,
    map: hosting.map ?? null,
    gametype: hosting.gametype ?? null,
  };
}

function chatSend(response, conversation, body) {
  const me = account.id;
  const clientId = String(body?.clientId ?? "");
  if (!/^[0-9A-Za-z]{10,32}$/.test(clientId)) return fail(response, 400, "invalid", "clientId must be a ULID");
  for (const other of chats.values()) {
    const stored = other.messages.find((message) => message.senderId === me && message.clientId === clientId);
    if (stored) return send(response, 200, messageWire(other, stored));
  }
  if (!canSend(conversation)) return refuse(response, 403, "forbidden", "not_friends", "You can only read this conversation");
  const text = cleanBody(body?.body);
  if ([...text].length > CHAT_MAX_BODY_CHARS) {
    return refuse(response, 400, "invalid", "too_long", `A message is at most ${CHAT_MAX_BODY_CHARS} characters`);
  }
  const rawCards = Array.isArray(body?.cards) ? body.cards : [];
  if (rawCards.length > CHAT_MAX_CARDS) return refuse(response, 400, "invalid", "card", `A message carries at most ${CHAT_MAX_CARDS} cards`);
  const cards = rawCards.map(checkCard);
  if (cards.some((card) => card === null)) return refuse(response, 400, "invalid", "card", "A card is not one this service knows");
  const fileIds = Array.isArray(body?.fileIds) ? body.fileIds.map(String) : [];
  if (fileIds.length > CHAT_MAX_FILES) return fail(response, 400, "invalid", `A message carries at most ${CHAT_MAX_FILES} files`);
  for (const fileId of fileIds) {
    const file = chatFiles.get(fileId);
    if (!file) return refuse(response, 404, "not_found", "file_gone", "That file is gone; upload it again");
    if (file.conversationId !== conversation.id || file.uploaderId !== me || file.status !== "ready" || file.messageSeq != null) {
      return refuse(response, 409, "conflict", "file_not_ready", "That file is not ready to be sent");
    }
  }
  if (!text.trim() && cards.length === 0 && fileIds.length === 0) {
    return refuse(response, 400, "invalid", "empty", "A message needs text, a card or a file");
  }
  const visible = visibleMessages(conversation);
  const replySeq = visible.some((message) => message.seq === body?.replySeq && message.kind === "user") ? body.replySeq : null;
  // Tokens of people who are not members become plain names.
  const cleaned = text.replace(/<@([0-9A-Za-z]+)>/g, (token, userId) => {
    if (conversation.members.has(userId)) return token;
    const user = userById(userId);
    return user ? `@${user.displayName}` : "";
  });
  const message = post(conversation, me, cleaned, { cards, fileIds, replySeq, clientId });
  announceMessage(conversation, message);
  scriptReply(conversation, message);
  return send(response, 201, messageWire(conversation, message));
}

function chatRead(response, conversation, body) {
  const member = conversation.members.get(account.id);
  const seq = Number(body?.seq);
  if (!Number.isInteger(seq) || seq < 0) return fail(response, 400, "invalid", "seq must be a whole number");
  member.readSeq = Math.max(member.readSeq, Math.min(seq, conversation.lastSeq));
  broadcastChat("chat.read", { conversationId: conversation.id, userId: account.id, seq: member.readSeq });
  return send(response, 200, { readSeq: member.readSeq });
}

function isEmoji(text) {
  const value = String(text ?? "");
  if (!value || Buffer.byteLength(value, "utf8") > 32 || [...value].length > 10) return false;
  if (/[\s\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(value)) return false;
  return !/[ -~]/.test(value.replace(/[0-9#*](?=[️⃣])/g, ""));
}

function chatReact(response, conversation, body) {
  const me = account.id;
  const message = visibleMessages(conversation).find((entry) => entry.seq === body?.seq && entry.kind === "user");
  if (!message) return fail(response, 404, "not_found", "No such message");
  if (!canSend(conversation)) return refuse(response, 403, "forbidden", "not_friends", "You can only read this conversation");
  if (!isEmoji(body?.emoji)) return fail(response, 400, "invalid", "That is not an emoji");
  const emoji = body.emoji;
  const on = body?.on !== false;
  if (on) {
    const mine = [...message.reactions.values()].filter((users) => users.has(me)).length;
    if (!message.reactions.get(emoji)?.has(me)) {
      if (mine >= 3) return fail(response, 400, "invalid", "At most three reactions per message");
      if (!message.reactions.has(emoji) && message.reactions.size >= 20) {
        return fail(response, 400, "invalid", "At most twenty different reactions per message");
      }
      message.reactions.set(emoji, new Set([...(message.reactions.get(emoji) ?? []), me]));
    }
  } else if (message.reactions.has(emoji)) {
    message.reactions.get(emoji).delete(me);
    if (message.reactions.get(emoji).size === 0) message.reactions.delete(emoji);
  }
  broadcastChat("chat.reaction", { conversationId: conversation.id, seq: message.seq, userId: me, emoji, on });
  return send(response, 200, {
    seq: message.seq,
    reactions: [...message.reactions].map(([key, users]) => ({ emoji: key, userIds: [...users] })),
  });
}

function chatNotify(response, conversation, body) {
  if (!["all", "mentions", "mute"].includes(body?.notify)) return fail(response, 400, "invalid", "notify must be all, mentions or mute");
  conversation.members.get(account.id).notify = body.notify;
  announceConversation(conversation);
  return send(response, 200, conversationWire(conversation));
}

function chatOpenDirect(response, userId) {
  const me = account.id;
  if (userId === me || !userById(userId)) return fail(response, 404, "not_found", "No such player");
  const existing = [...chats.values()].find((conversation) => conversation.kind === "direct" && conversation.peerId === userId);
  if (existing) return send(response, 200, conversationWire(existing));
  if (!isFriend(userId)) return fail(response, 404, "not_found", "No such player");
  const conversation = newConversation("direct", { peerId: userId });
  addMember(conversation, me);
  addMember(conversation, userId);
  announceConversation(conversation);
  return send(response, 201, conversationWire(conversation));
}

/** Adds a member after its join message, which is the first message it sees
 *  unless the conversation shows history to new members (D1). */
function join(conversation, userId, event, by) {
  const message = systemPost(conversation, event, { userId, by });
  addMember(conversation, userId, { visibleFromSeq: conversation.historyForNewMembers ? 0 : message.seq - 1 });
  return message;
}

function chatCreateGroup(response, body) {
  const me = account.id;
  const clientId = String(body?.clientId ?? "");
  if (!clientId) return fail(response, 400, "invalid", "clientId is required");
  const replay = [...chats.values()].find((conversation) => conversation.ownerId === me && conversation.createClientId === clientId);
  if (replay) return send(response, 200, { conversation: conversationWire(replay), added: [], invited: [], refused: [] });
  const title = body?.title == null ? null : String(body.title).trim() || null;
  if (title && [...title].length > 64) return fail(response, 400, "invalid", "A title is at most 64 characters");
  const ids = [...new Set(Array.isArray(body?.memberIds) ? body.memberIds.map(String) : [])].filter((userId) => userId !== me);
  if (ids.length > CHAT_GROUP_MAX_MEMBERS - 1) return refuse(response, 400, "invalid", "group_full", "That is more people than a group holds");
  const conversation = newConversation("group", { ownerId: me, title, createClientId: clientId });
  addMember(conversation, me, { role: "owner" });
  const added = [];
  const invited = [];
  const refused = [];
  for (const userId of ids) {
    if (!isFriend(userId)) refused.push({ userId, reason: "not_friend" });
    else if (asksBeforeAdding(userId)) invited.push(userId);
    else {
      addMember(conversation, userId);
      added.push(userId);
    }
  }
  systemPost(conversation, "created", { by: me });
  announceConversation(conversation);
  return send(response, 201, { conversation: conversationWire(conversation), added, invited, refused });
}

function chatPatchGroup(response, conversation, body) {
  const me = account.id;
  if (body?.title === undefined && body?.historyForNewMembers === undefined) {
    return fail(response, 400, "invalid", "Change the title or the history setting");
  }
  if (conversation.ownerId !== me) return refuse(response, 403, "forbidden", "owner_only", "Only the owner of the group can change it");
  if (body.title !== undefined) {
    const title = body.title == null ? null : String(body.title).trim() || null;
    if (title && [...title].length > 64) return fail(response, 400, "invalid", "A title is at most 64 characters");
    if (title !== conversation.title) {
      conversation.title = title;
      announceMessage(conversation, systemPost(conversation, "renamed", { by: me, title }));
    }
  }
  if (body.historyForNewMembers !== undefined) {
    const on = Boolean(body.historyForNewMembers);
    if (on !== conversation.historyForNewMembers) {
      conversation.historyForNewMembers = on;
      announceMessage(conversation, systemPost(conversation, "historyForNewMembers", { on, by: me }));
    }
  }
  announceConversation(conversation);
  return send(response, 200, conversationWire(conversation));
}

function chatAddMembers(response, conversation, body) {
  const me = account.id;
  const ids = [...new Set(Array.isArray(body?.userIds) ? body.userIds.map(String) : [])];
  const added = [];
  const invited = [];
  const refused = [];
  for (const userId of ids) {
    if (conversation.members.has(userId)) refused.push({ userId, reason: "member" });
    else if (!isFriend(userId)) refused.push({ userId, reason: "not_friend" });
    else if (conversation.members.size >= CHAT_GROUP_MAX_MEMBERS) refused.push({ userId, reason: "full" });
    else if (asksBeforeAdding(userId)) invited.push(userId);
    else {
      announceMessage(conversation, join(conversation, userId, "memberAdded", me));
      added.push(userId);
    }
  }
  announceConversation(conversation);
  return send(response, 200, { added, invited, refused });
}

function chatJoinGroup(response, conversation) {
  const me = account.id;
  const invite = groupInvites.find((entry) => entry.conversationId === conversation.id);
  if (!invite) return fail(response, 404, "not_found", "That invite is gone");
  if (conversation.members.size >= CHAT_GROUP_MAX_MEMBERS) return refuse(response, 409, "conflict", "group_full", "The group is full");
  groupInvites = groupInvites.filter((entry) => entry !== invite);
  const message = join(conversation, me, "memberJoined", null);
  announceMessage(conversation, message);
  announceConversation(conversation);
  broadcastChat("chat.groupInvite.removed", { conversationId: conversation.id });
  return send(response, 200, conversationWire(conversation));
}

/** Deletes a conversation and tells the account, if it was a member. */
function endChat(conversation, reason) {
  const wasMember = conversation.members.has(account.id);
  chats.delete(conversation.id);
  if (wasMember) broadcastChat("chat.conversation.removed", { conversationId: conversation.id, reason });
}

function chatRemoveMember(response, conversationId, userId) {
  const me = account.id;
  const conversation = chats.get(conversationId);
  if (!conversation || !conversation.members.has(me)) return noConversation(response);
  if (conversation.kind === "direct") return fail(response, 400, "invalid", "A direct conversation cannot be left");
  if (userId === me) {
    conversation.members.delete(me);
    systemPost(conversation, "memberLeft", { userId: me });
    if (conversation.ownerId === me && conversation.kind === "group") {
      // D4: the earliest-joined remaining member takes over.
      const next = [...conversation.members.values()].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))[0];
      if (next) {
        next.role = "owner";
        conversation.ownerId = next.userId;
        systemPost(conversation, "ownerChanged", { userId: next.userId, by: me });
      }
    }
    if (conversation.members.size === 0 || (conversation.kind === "server" && conversation.ownerId === me)) chats.delete(conversation.id);
    broadcastChat("chat.conversation.removed", { conversationId, reason: "left" });
    return send(response, 204, null);
  }
  if (conversation.ownerId !== me) return refuse(response, 403, "forbidden", "owner_only", "Only the owner can remove members");
  if (!conversation.members.has(userId)) return fail(response, 404, "not_found", "Not a member");
  conversation.members.delete(userId);
  announceMessage(conversation, systemPost(conversation, "memberRemoved", { userId, by: me }));
  announceConversation(conversation);
  return send(response, 204, null);
}

function chatOpenServer(response, sessionId) {
  const me = account.id;
  if (presence.hosting?.sessionId !== sessionId) {
    return refuse(response, 409, "conflict", "not_hosting", "You are not hosting that server");
  }
  const existing = [...chats.values()].find((conversation) => conversation.kind === "server" && conversation.ownerId === me && conversation.server.sessionId === sessionId);
  if (existing) return send(response, 200, conversationWire(existing));
  for (const conversation of [...chats.values()]) {
    if (conversation.kind === "server" && conversation.ownerId === me) endChat(conversation, "ended");
  }
  const conversation = newConversation("server", { ownerId: me, server: { hostId: me, sessionId } });
  addMember(conversation, me, { role: "owner" });
  systemPost(conversation, "serverStarted", { by: me });
  announceConversation(conversation);
  return send(response, 201, conversationWire(conversation));
}

function chatJoinServer(response, sessionId, body) {
  const me = account.id;
  const hostId = String(body?.hostUserId ?? "");
  const conversation = [...chats.values()].find((entry) => entry.kind === "server" && entry.server.hostId === hostId && entry.server.sessionId === sessionId);
  const host = world.friends.find((friend) => friend.user.id === hostId);
  if (!conversation || host?.presence?.hosting?.sessionId !== sessionId) return noConversation(response);
  if (conversation.members.has(me)) return send(response, 200, conversationWire(conversation));
  const invited = world.invites.some((invite) => invite.from.id === hostId && invite.hosting?.sessionId === sessionId);
  if (!hostingFor(host.presence.hosting, me).canJoin && !invited) {
    return fail(response, 403, "forbidden", "The host did not open the server to you");
  }
  announceMessage(conversation, join(conversation, me, "memberJoined", null));
  announceConversation(conversation);
  return send(response, 200, conversationWire(conversation));
}

function chatPatchServer(response, sessionId, body) {
  const me = account.id;
  const conversation = [...chats.values()].find((entry) => entry.kind === "server" && entry.server.sessionId === sessionId && entry.members.has(me));
  if (!conversation) return noConversation(response);
  if (conversation.ownerId !== me) return refuse(response, 403, "forbidden", "owner_only", "Only the host can change the chat of the server");
  if (typeof body?.historyForNewMembers !== "boolean") return fail(response, 400, "invalid", "historyForNewMembers must be true or false");
  if (body.historyForNewMembers !== conversation.historyForNewMembers) {
    conversation.historyForNewMembers = body.historyForNewMembers;
    announceMessage(conversation, systemPost(conversation, "historyForNewMembers", { on: body.historyForNewMembers, by: me }));
  }
  announceConversation(conversation);
  return send(response, 200, conversationWire(conversation));
}

function chatSearch(response, url) {
  const q = String(url.searchParams.get("q") ?? "").trim();
  const conversationId = url.searchParams.get("conversationId");
  const senderId = url.searchParams.get("senderId");
  const has = url.searchParams.get("has");
  const cursor = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : Infinity;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), 50);
  if (!q || [...q].length > 64) return fail(response, 400, "invalid", "Search for 1 to 64 characters");
  if ([...q].length < 3 && !conversationId) return fail(response, 400, "invalid", "A search of one or two characters needs a conversation");
  const needle = q.toLocaleLowerCase();
  const hits = [];
  for (const conversation of myConversations()) {
    if (conversationId && conversation.id !== conversationId) continue;
    for (const message of visibleMessages(conversation)) {
      if (message.kind !== "user" || message.pk >= cursor) continue;
      if (senderId && message.senderId !== senderId) continue;
      const files = message.fileIds.map((fileId) => chatFiles.get(fileId)).filter(Boolean);
      if (has === "file" && files.length === 0) continue;
      if ((has === "image" || has === "video") && !files.some((file) => file.class === has)) continue;
      if (has === "card" && message.cards.length === 0) continue;
      if (has === "link" && !message.body.includes("://")) continue;
      const names = chatText(message.body).replace(/<@([0-9A-Za-z]+)>/g, (token, userId) => userById(userId)?.displayName ?? "");
      const text = [names, ...message.cards.map((card) => card.fallbackText ?? ""), ...files.map((file) => file.name)].join("\n");
      if (text.toLocaleLowerCase().includes(needle)) hits.push({ conversation, message });
    }
  }
  hits.sort((a, b) => b.message.pk - a.message.pk);
  const page = hits.slice(0, limit);
  return send(response, 200, {
    results: page.map(({ conversation, message }) => ({ message: messageWire(conversation, message) })),
    nextCursor: hits.length > limit ? String(page[page.length - 1].message.pk) : null,
  });
}

/** What the service calls the file, whatever the sender said. */
function sanitizeFileName(name) {
  const cleaned = String(name ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f‪-‮⁦-⁩]/g, "")
    .replace(/[. ]+$/, "")
    .slice(0, 120);
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(cleaned) || !cleaned ? "file" : cleaned;
}

function classifyFile(name, bytes) {
  const extension = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  const head = bytes.subarray(0, 8);
  const executable =
    head.subarray(0, 2).toString("latin1") === "MZ" ||
    head.subarray(0, 4).toString("latin1") === "\u007fELF" ||
    head.subarray(0, 2).toString("latin1") === "#!" ||
    CHAT_EXECUTABLE_EXTENSIONS.has(extension);
  if (executable) return { class: "executable", mediaType: "application/octet-stream", danger: true };
  const picture = imageType(bytes);
  if (picture) return { class: "image", mediaType: picture, danger: false };
  if (bytes.subarray(4, 8).toString("latin1") === "ftyp") return { class: "video", mediaType: "video/mp4", danger: false };
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { class: "video", mediaType: "video/webm", danger: false };
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return { class: "archive", mediaType: "application/octet-stream", danger: false };
  if (["dm_25", "dm_26", "dm_15"].includes(extension)) return { class: "demo", mediaType: "application/octet-stream", danger: false };
  if (extension === "cfg" && !bytes.includes(0)) return { class: "config", mediaType: "application/octet-stream", danger: false };
  return { class: "other", mediaType: "application/octet-stream", danger: false };
}

function chatRegisterFile(response, body) {
  const me = account.id;
  const conversation = chats.get(String(body?.conversationId ?? ""));
  if (!conversation || !conversation.members.has(me)) return noConversation(response);
  if (!canSend(conversation)) return refuse(response, 403, "forbidden", "not_friends", "You can only read this conversation");
  const size = Number(body?.size);
  if (!Number.isInteger(size) || size < 1 || size > CHAT_MAX_FILE_BYTES) {
    return refuse(response, 400, "invalid", "file_too_large", `A file is 1 byte to ${CHAT_MAX_FILE_BYTES} bytes`);
  }
  const sha256 = String(body?.sha256 ?? "");
  if (!/^[0-9a-f]{64}$/.test(sha256)) return fail(response, 400, "invalid", "sha256 must be 64 lowercase hex characters");
  const quota = chatQuota();
  if (quota.usedBytes + size > quota.quotaBytes) {
    return refuse(response, 400, "invalid", "quota_account", "Your chat files are over the quota", { usedBytes: quota.usedBytes, quotaBytes: quota.quotaBytes });
  }
  // Only a copy whose bytes are still there spares the upload, as the
  // service checks that the file exists on disk.
  const own = [...chatFiles.values()].find(
    (file) => file.uploaderId === me && file.sha256 === sha256 && file.status === "ready" && file.bytes,
  );
  const file = {
    id: id(),
    conversationId: conversation.id,
    uploaderId: me,
    messageSeq: null,
    sha256,
    size,
    name: sanitizeFileName(body?.name),
    mediaType: own?.mediaType ?? "application/octet-stream",
    class: own?.class ?? "other",
    danger: own?.danger ?? false,
    meta: body?.meta ?? null,
    status: own ? "ready" : "pending",
    bytes: own?.bytes ?? null,
    createdAt: nowIso(),
  };
  chatFiles.set(file.id, file);
  return send(response, 201, { file: fileWire(file), needsUpload: !own });
}

function chatUploadFile(request, response, fileId, bytes) {
  const file = chatFiles.get(fileId);
  if (!file || file.uploaderId !== account.id) return fail(response, 404, "not_found", "No such file");
  if (file.status === "ready") return send(response, 200, { file: fileWire(file) });
  const length = Number(request.headers["content-length"]);
  if (length !== file.size || bytes.length !== file.size) {
    return refuse(response, 400, "invalid", "size_mismatch", "The body is not the size the file was registered with");
  }
  if (sha256Of(bytes) !== file.sha256) return refuse(response, 400, "invalid", "hash_mismatch", "The SHA-256 of the body does not match");
  Object.assign(file, classifyFile(file.name, bytes), { status: "ready", bytes });
  console.log(`  chat file ${file.name}, ${file.size} bytes, ${file.class}`);
  return send(response, 200, { file: fileWire(file) });
}

function chatDownloadFile(request, response, fileId, headOnly) {
  const me = account.id;
  const file = chatFiles.get(fileId);
  const conversation = file && chats.get(file.conversationId);
  const member = conversation?.members.get(me);
  const allowed =
    file?.status === "ready" &&
    (file.uploaderId === me || (file.messageSeq != null && member && file.messageSeq > member.visibleFromSeq));
  if (!allowed) return fail(response, 404, "not_found", "No such file");
  if (!file.bytes) return refuse(response, 404, "not_found", "file_gone", "The file is no longer stored");
  const bytes = file.bytes;
  const headers = {
    "content-type": ["image", "video"].includes(file.class) ? file.mediaType : "application/octet-stream",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "accept-ranges": "bytes",
    etag: `"${file.sha256}"`,
    "cache-control": "no-store",
    ...CORS,
  };
  let start = 0;
  let end = bytes.length - 1;
  let status = 200;
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
  if (range) {
    start = Number(range[1]);
    end = range[2] ? Math.min(Number(range[2]), end) : end;
    if (start >= bytes.length || start > end) {
      response.writeHead(416, { ...headers, "content-range": `bytes */${bytes.length}` });
      return response.end();
    }
    status = 206;
    headers["content-range"] = `bytes ${start}-${end}/${bytes.length}`;
  }
  const slice = bytes.subarray(start, end + 1);
  headers["content-length"] = slice.length;
  response.writeHead(status, headers);
  return response.end(headOnly ? undefined : slice);
}

/** Not in the contract: the bytes of a chat file go, its row stays ready, so
 *  the download answers `404 file_gone` and a screen shows the file as
 *  unavailable. */
function devChatLoseFile(response, fileId) {
  const file = chatFiles.get(fileId);
  if (!file) return fail(response, 404, "not_found", "No such file");
  file.bytes = null;
  return send(response, 200, { file: fileWire(file) });
}

/** Not in the contract: a member of the cast posts on demand, so a toast or
 *  a badge can be looked at without waiting for a scripted answer.
 *  `cards` posts cards as they are, at most five with the message; `"all"`
 *  posts one message per card kind (`showcaseCards`) and answers the list. */
function devChatPost(response, body) {
  const me = account.id;
  const conversation = body?.conversationId
    ? chats.get(String(body.conversationId))
    : [...chats.values()].find((entry) => entry.kind === "direct" && entry.peerId === cast?.kyle.id);
  if (!conversation || !conversation.members.has(me)) return noConversation(response);
  const sender = [...conversation.members.keys()].find((userId) => userId !== me && userById(userId));
  if (!sender) return fail(response, 409, "conflict", "Nobody else is in that conversation");
  if (body?.cards === "all") {
    const messages = showcaseCards().map((card) => {
      const message = post(conversation, sender, "", { cards: [card] });
      announceMessage(conversation, message);
      return messageWire(conversation, message);
    });
    return send(response, 201, messages);
  }
  const cards = Array.isArray(body?.cards) ? body.cards.slice(0, CHAT_MAX_CARDS) : [];
  let text = String(body?.body ?? (cards.length > 0 ? "" : "Anyone up for a duel?"));
  if (body?.mention) text = `<@${me}> ${text}`;
  const message = post(conversation, sender, text, { cards });
  announceMessage(conversation, message);
  return send(response, 201, messageWire(conversation, message));
}

/** One card of every kind but `hostInvite`, which needs a live server (Jan's
 *  direct conversation carries one), as a launcher of the cast sends them.
 *  The bundle is a published bundle of this mock; the bind and the config
 *  hold lines the launcher's danger scan names. */
function showcaseCards() {
  const bundle = [...bundles.values()].find(
    (entry) => !entry.hidden && entry.versions.some((version) => version.status === "published"),
  );
  return [
    {
      type: "server", v: 1, fallbackText: "Server: Duel Arena (203.0.113.10:29070)",
      address: "203.0.113.10:29070", name: "Duel Arena", game: "ja", map: "mp/duel6", gametype: 3,
    },
    ...(bundle
      ? [{ type: "bundle", v: 1, fallbackText: `Bundle: ${bundle.name}`, bundleId: bundle.id, slug: bundle.slug, name: bundle.name, game: bundle.game }]
      : []),
    {
      type: "jkhubMod", v: 1, fallbackText: "JKHub: Trilogy Sabers : Episode 3",
      fileId: 4391, slug: "trilogy-sabers-episode-3", title: "Trilogy Sabers : Episode 3", game: "ja",
    },
    { type: "map", v: 1, fallbackText: "Map: Bespin Streets (mp/ffa3)", game: "ja", name: "mp/ffa3", title: "Bespin Streets" },
    {
      type: "profile", v: 1, fallbackText: "Player profile: Kyle",
      nickname: "^4Kyle", model: "kyle/default", saber1: "Kyle", color1: "4", color2: "1", charColor: "255 255 255",
    },
    {
      type: "bind", v: 1, fallbackText: "3 key binds: F1, F2, F3",
      binds: [
        { key: "F1", command: "say gg" },
        { key: "F2", command: "+attack; wait; -attack" },
        { key: "F3", command: "quit" },
      ],
    },
    {
      type: "config", v: 1, fallbackText: "Config: duel.cfg", name: "duel.cfg",
      text: "seta cg_fov 110\nset duel \"say duel?; exec duel2\"\nbind MOUSE3 vstr duel\nseta cl_allowDownload 1\n",
    },
  ];
}


// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/**
 * The real service needs none of this: the launcher is not a browser origin, and
 * the contract says so. The mock allows everything because `npm run dev` puts
 * the same frontend on `http://localhost:14xx`, and reviewing the Friends
 * screen there is half of what this file is for.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "access-control-max-age": "86400",
};

function withAuth(request, response, handler) {
  const header = request.headers.authorization ?? "";
  const sent = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || sent !== token) {
    return send(response, 401, {
      error: { code: "unauthorized", message: "sign in first" },
    });
  }
  if (!account) return notFound(response);
  return handler();
}

function notFound(response) {
  return send(response, 404, {
    error: { code: "not_found", message: "no such endpoint" },
  });
}

function fail(response, status, code, message) {
  return send(response, status, { error: { code, message } });
}

function send(response, status, payload) {
  const headers = { "cache-control": "no-store", ...CORS };
  if (payload === null) {
    response.writeHead(status, headers);
    return response.end();
  }
  const text = JSON.stringify(payload);
  headers["content-type"] = "application/json; charset=utf-8";
  headers["content-length"] = Buffer.byteLength(text);
  response.writeHead(status, headers);
  return response.end(text);
}

function readBody(request, raw = false) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      if (raw) return resolve(Buffer.concat(chunks));
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        // The launcher always sends JSON; anything else is a test poking at
        // the mock, and null is enough for the handlers to refuse it.
        resolve(null);
      }
    });
  });
}

function argOrEnv(flag, variable, fallback) {
  const index = process.argv.indexOf(flag);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return process.env[variable] ?? fallback;
}

/** A stand-in for a ULID: the launcher only needs it to be opaque and safe in
 *  a URL path. */
/** A ULID-shaped id, as the service hands out: 26 characters of Crockford's
 *  base 32 (hex is a subset) with the first at most 7, so a launcher that
 *  checks the form, as the check of a bundle card does, accepts it. */
function id() {
  const bytes = randomBytes(13);
  bytes[0] &= 0x7f;
  return bytes.toString("hex").toUpperCase();
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A time this many milliseconds from now; negative reaches into the past. */
function later(ms) {
  return new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function escapeHtml(text) {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

// ---------------------------------------------------------------------------
// The live socket, RFC 6455 by hand
// ---------------------------------------------------------------------------

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const sockets = new Set();

server.on("upgrade", (request, socket) => {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  const key = request.headers["sec-websocket-key"];
  // The launcher sends the token in the header; launchers up to 0.5.0 sent
  // it as ?token=, which the service still accepts, so the mock does too.
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
  if (url.pathname !== "/v1/ws" || !(bearer || url.searchParams.get("token")) || !key) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  const answer = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${answer}\r\n\r\n`,
  );
  // --- slice: chat --- only a socket that asks for chat frames gets them,
  // which is what keeps launchers up to 0.6.0 unaware of chat.
  const chat = String(request.headers["x-jknet-features"] ?? "")
    .split(",")
    .some((feature) => feature.trim().toLowerCase() === "chat");
  console.log(`WS open${chat ? " (chat)" : ""}`);

  const client = { socket, missed: 0, buffer: Buffer.alloc(0), chat };
  sockets.add(client);

  const ping = setInterval(() => {
    if (client.missed >= MISSED_PONGS_ALLOWED) {
      console.log("WS closing: three pongs missed");
      stop();
      return;
    }
    client.missed += 1;
    write(socket, frame("ping", {}));
    // The scripted move: one friend hops between two servers on every beat,
    // which is what exercises `friends:presence` in the launcher.
    const kyle = world.friends.find((friend) => friend.user.id === cast?.kyle.id);
    if (kyle) {
      const next = SERVERS[Math.floor(Math.random() * SERVERS.length)];
      kyle.presence = {
        status: "in_game",
        ...next,
        clientName: "Everyday",
        since: nowIso(),
      };
      write(
        socket,
        frame("presence.updated", { userId: kyle.user.id, presence: friendView(kyle).presence }),
      );
    }
  }, PING_INTERVAL_MS);

  const invite = setTimeout(() => {
    const entry = incomingInvite();
    world.invites.unshift(entry);
    console.log("WS invite sent");
    write(socket, frame("invite", { invite: entry }));
  }, INVITE_DELAY_MS);

  const stop = () => {
    clearInterval(ping);
    clearTimeout(invite);
    sockets.delete(client);
    socket.destroy();
  };

  socket.on("data", (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    for (const message of drain(client)) {
      if (message.opcode === 0x8) {
        stop();
        return;
      }
      if (message.opcode === 0x9) {
        write(socket, encode(0xa, message.payload));
        continue;
      }
      if (message.opcode !== 0x1) continue;
      try {
        const incoming = JSON.parse(message.payload.toString("utf8"));
        if (incoming.type === "pong") {
          client.missed = 0;
        } else if (incoming.type === "chat.typing" && client.chat) {
          // --- slice: chat --- the other members are the cast, who have
          // no sockets to relay the hint to; it is kept for the dev route.
          const conversationId = String(incoming.payload?.conversationId ?? "");
          typingSeen.push({ conversationId, at: nowIso() });
          if (typingSeen.length > 100) typingSeen.shift();
          console.log(`  typing -> ${conversationId}`);
        }
      } catch {
        /* a frame that is not JSON is neither */
      }
    }
  });
  socket.on("error", stop);
  socket.on("close", () => {
    console.log("WS closed");
    stop();
  });

  // One ping straight away, so a client can prove its pong path without
  // waiting out the interval.
  write(socket, frame("ping", {}));
  client.missed = 1;
});

const frame = (type, payload) =>
  encode(0x1, Buffer.from(JSON.stringify({ type, payload, at: nowIso() }), "utf8"));

const broadcast = (type, payload) => {
  for (const client of sockets) write(client.socket, frame(type, payload));
};

const write = (socket, buffer) => {
  if (!socket.destroyed) socket.write(buffer);
};

/** Builds one unmasked frame. Servers never mask, per RFC 6455 §5.1. */
function encode(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Pulls whole frames out of the buffer, unmasking as it goes.
 *
 * Continuation frames are not handled: nothing in the contract sends a
 * message big enough for a client to split.
 */
function* drain(client) {
  for (;;) {
    const buffer = client.buffer;
    if (buffer.length < 2) return;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buffer.length < offset + 2) return;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return;
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }

    const mask = masked ? buffer.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (buffer.length < offset + length) return;

    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    client.buffer = buffer.subarray(offset + length);
    yield { opcode, payload };
  }
}
