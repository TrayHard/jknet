/**
 * A stand-in for the JKNet hub, for developing the launcher without one.
 *
 * The real hub is a separate service. This script answers the part of API v1
 * the launcher uses — sign-in, the account, friends, presence, invites and the
 * live socket — keeps everything in memory, and depends on nothing but Node
 * itself, so it starts in the time it takes to read this sentence and forgets
 * everything when it stops.
 *
 * Run it:
 *
 *     node scripts/mock-hub.mjs
 *     node scripts/mock-hub.mjs --port 8799
 *
 * Then point the launcher at it: the stock `hubUrl` is already
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
 *     GET    /v1/ws?token=                the live socket
 *
 * Two routes are deliberately outside the contract, both marked below:
 * `POST /v1/dev/token` hands out a token without the browser round trip, and
 * `POST /v1/dev/invite` makes an invitation arrive on demand.
 *
 * Environment:
 *
 *     PORT                  8787       where to listen
 *     MOCK_HUB_PROVIDERS    dev        providers that may open a session
 *     MOCK_HUB_DEV_DELAY_MS 3000       how long a dev session stays pending
 *                                      when no browser opens its form
 *     MOCK_HUB_TAKEN_NAME   Taken      display name that answers 409
 *
 * What it is not: it does not check the shape of what you send it beyond what
 * the launcher needs to see refused, and it has no persistence. A test that
 * needs a hub to behave badly should say so here.
 *
 * No dependencies on purpose. The WebSocket handshake and framing at the end
 * are RFC 6455 by hand, and cover only what the contract uses — text frames,
 * ping, pong and close.
 */

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const PORT = Number(argOrEnv("--port", "PORT", "8787"));
const HOST = "127.0.0.1";
const PROVIDERS = (process.env.MOCK_HUB_PROVIDERS ?? "dev")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const DEV_DELAY_MS = Number(process.env.MOCK_HUB_DEV_DELAY_MS ?? "3000");
const TAKEN_NAME = process.env.MOCK_HUB_TAKEN_NAME ?? "Taken";

/** Every provider of the contract, so an unknown one is a 400 and not a 503. */
const KNOWN_PROVIDERS = ["jkhub", "discord", "dev"];

/** The hub pings this often, and moves a friend around on the same beat. */
const PING_INTERVAL_MS = 20_000;
/** How long after a connection the scripted invite arrives. */
const INVITE_DELAY_MS = 40_000;
/** A client that misses this many pongs is dropped, as in the contract. */
const MISSED_PONGS_ALLOWED = 3;

/** Sign-in sessions by id. A session lives ten minutes, as in the contract. */
const sessions = new Map();
/** Session id by the `state` its dev form carries, as on the real hub. */
const states = new Map();
/** The one account this hub has, created by the first completed sign-in. */
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
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  readBody(request)
    .then((body) => route(request, response, url, body))
    .catch((e) => {
      // A mock that throws should say so on the console rather than hang the
      // launcher that is waiting for it.
      console.error(`mock-hub: ${e instanceof Error ? e.stack : e}`);
      send(response, 500, { error: { code: "internal", message: String(e) } });
    });
});

server.listen(PORT, HOST, () => {
  console.log(`mock-hub listening on http://${HOST}:${PORT}`);
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
      const invite = incomingInvite();
      world.invites.unshift(invite);
      broadcast("invite", { invite });
      return send(response, 201, invite);
    });
  }

  if (path === "/v1/me") {
    return withAuth(request, response, () => {
      if (method === "GET") return send(response, 200, { user: account, presence });
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
        friends: world.friends,
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
      return send(response, 200, friend);
    });
  }

  const requestMatch = path.match(/^\/v1\/friends\/requests\/([^/]+)$/);
  if (requestMatch && method === "DELETE") {
    return withAuth(request, response, () => {
      const gone = drop(requestMatch[1]);
      if (!gone) return fail(response, 404, "not_found", "That request is gone.");
      // The real hub tells the other side, and says it with `friend.removed`:
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
      return send(response, 204, null);
    });
  }

  if (path === "/v1/presence" && method === "PUT") {
    return withAuth(request, response, () => {
      if (!["online", "in_game"].includes(body?.status)) {
        return fail(response, 400, "invalid", "status must be online or in_game.");
      }
      presence = {
        status: body.status,
        serverAddress: body.serverAddress ?? null,
        serverName: body.serverName ?? null,
        clientName: body.clientName ?? null,
        since: nowIso(),
      };
      console.log(`  presence -> ${presence.status} ${presence.serverAddress ?? ""}`);
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
      const invite = {
        id: id(),
        from: account,
        serverAddress: body.serverAddress,
        serverName: body.serverName ?? null,
        message: body.message ?? null,
        createdAt: nowIso(),
        expiresAt: later(10 * 60_000),
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
    // What the real hub answers until JKHub and Discord issue OAuth clients.
    const name = provider === "jkhub" ? "JKHub" : "Discord";
    return send(response, 503, {
      error: {
        code: "provider_error",
        message: `${name} sign-in is not configured yet`,
      },
    });
  }

  const session = newSession(provider, body?.deviceName ?? null);
  console.log(`mock-hub: session ${session.id} opened for ${provider}`);

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
 *  The real hub does the same, and its form submits to
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
  console.log(`mock-hub: session ${session.id} completed as ${account.displayName}`);
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

/** The invitation the scripted friend sends. */
function incomingInvite() {
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

/** Matches a display name, a `provider:name` or an id, as the hub does. */
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
// Plumbing
// ---------------------------------------------------------------------------

/**
 * The real hub needs none of this: the launcher is not a browser origin, and
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

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
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
function id() {
  return randomBytes(13).toString("hex").toUpperCase();
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
  if (url.pathname !== "/v1/ws" || !url.searchParams.get("token") || !key) {
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
  console.log("WS open");

  const client = { socket, missed: 0, buffer: Buffer.alloc(0) };
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
        frame("presence.updated", { userId: kyle.user.id, presence: kyle.presence }),
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
        if (JSON.parse(message.payload.toString("utf8")).type === "pong") {
          client.missed = 0;
        }
      } catch {
        /* a frame that is not JSON is not a pong */
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
