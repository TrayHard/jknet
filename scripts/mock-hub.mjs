/**
 * A stand-in for the JKNet hub, for developing the launcher without one.
 *
 * The real hub is a separate service. This script answers the part of API v1
 * the sign-in and account slice uses, keeps everything in memory, and depends
 * on nothing but Node itself, so it starts in the time it takes to read this
 * sentence and forgets everything when it stops.
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
 *     GET    /v1/friends                  two fixed friends
 *     PUT    /v1/presence
 *     GET    /v1/invites                  always empty
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
 * the launcher needs to see refused, it has no persistence, and it has no
 * WebSocket. A test that needs a hub to behave badly should say so here.
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const PORT = Number(argOrEnv("--port", "PORT", "8787"));
const PROVIDERS = (process.env.MOCK_HUB_PROVIDERS ?? "dev")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const DEV_DELAY_MS = Number(process.env.MOCK_HUB_DEV_DELAY_MS ?? "3000");
const TAKEN_NAME = process.env.MOCK_HUB_TAKEN_NAME ?? "Taken";

/** Every provider of the contract, so an unknown one is a 400 and not a 503. */
const KNOWN_PROVIDERS = ["jkhub", "discord", "dev"];

/** Sign-in sessions by id. A session lives ten minutes, as in the contract. */
const sessions = new Map();
/** Session id by the `state` its dev form carries, as on the real hub. */
const states = new Map();
/** The one account this hub has, created by the first completed sign-in. */
let account = null;
/** The token of that account. Cleared by a logout or a delete. */
let token = null;
/** Where the launcher last said the player was. */
let presence = { status: "offline", since: nowIso() };

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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock-hub listening on http://127.0.0.1:${PORT}`);
  console.log(`  providers: ${PROVIDERS.join(", ") || "(none)"}`);
  console.log(`  a dev sign-in completes after ${DEV_DELAY_MS} ms`);
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function route(request, response, url, body) {
  const method = request.method ?? "GET";
  const path = url.pathname.replace(/\/+$/, "") || "/";

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
      presence = { status: "offline", since: nowIso() };
      return send(response, 204, null);
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
      send(response, 200, { friends: friends(), incoming: [], outgoing: [] }),
    );
  }

  if (path === "/v1/presence" && method === "PUT") {
    return withAuth(request, response, () => {
      presence = {
        status: body?.status ?? "online",
        serverAddress: body?.serverAddress ?? null,
        serverName: body?.serverName ?? null,
        clientName: body?.clientName ?? null,
        since: nowIso(),
      };
      return send(response, 200, presence);
    });
  }

  if (path === "/v1/invites" && method === "GET") {
    return withAuth(request, response, () => send(response, 200, []));
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

  const session = {
    id: id(),
    provider,
    status: "pending",
    token: null,
    user: null,
    error: null,
    expiresAt: Date.now() + 10 * 60 * 1000,
    deviceName: body?.deviceName ?? null,
    tokenRead: false,
  };
  session.url = `http://127.0.0.1:${PORT}/v1/auth/${provider}/start?session=${session.id}`;
  sessions.set(session.id, session);
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
  account = {
    id: account?.id ?? id(),
    displayName: account?.displayName ?? displayName,
    avatarUrl: null,
    provider: session.provider,
    providerName: displayName.toLowerCase().replace(/\s+/g, "_"),
    createdAt: account?.createdAt ?? nowIso(),
  };
  token = randomBytes(32).toString("hex");
  presence = { status: "online", since: nowIso() };

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
// Account
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

/** Two friends, one in a game and one idle, so the Friends screen has both
 *  states to draw without a second player being online. */
function friends() {
  return [
    {
      user: {
        id: "01JKNETFRIEND0000000000001",
        displayName: "Jaden Korr",
        avatarUrl: null,
        provider: "jkhub",
        providerName: "jaden",
        createdAt: "2026-01-04T09:12:00Z",
      },
      presence: {
        status: "in_game",
        serverAddress: "203.0.113.10:29070",
        serverName: "EU FFA",
        clientName: "Everyday",
        since: nowIso(),
      },
      friendsSince: "2026-02-01T18:00:00Z",
    },
    {
      user: {
        id: "01JKNETFRIEND0000000000002",
        displayName: "Rosh Penin",
        avatarUrl: null,
        provider: "discord",
        providerName: "rosh",
        createdAt: "2026-03-18T20:40:00Z",
      },
      presence: { status: "online", since: nowIso() },
      friendsSince: "2026-04-02T12:30:00Z",
    },
  ];
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

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

function send(response, status, payload) {
  const headers = { "cache-control": "no-store" };
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

function escapeHtml(text) {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
