/**
 * A stand-in for the JKNet hub, API v1.
 *
 * Enough of `hub-api.md` to develop the Friends screen against: the friends
 * list, requests, invites, the presence echo and the live socket. Sign-in is
 * deliberately absent — the account slice owns it — so this mock hands out a
 * token to anybody who asks for one and believes every bearer it sees.
 *
 *   node scripts/mock-hub.mjs          # 127.0.0.1:8787
 *   PORT=9000 node scripts/mock-hub.mjs
 *
 * Point the launcher at it by putting `"hubUrl": "http://127.0.0.1:8787"` and
 * any 64-character `"hubToken"` into `settings.json`, or by pressing **Use the
 * mock hub** on the Friends screen while the launcher runs in development.
 *
 * No dependencies on purpose: `package.json` is shared by three branches, and
 * a mock is not worth a merge conflict. The WebSocket handshake and framing
 * below are RFC 6455 by hand, and cover only what the contract uses — text
 * frames, ping, pong and close.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = "127.0.0.1";

/** The hub pings this often, and moves a friend around on the same beat. */
const PING_INTERVAL_MS = 20_000;

/** How long after a connection the scripted invite arrives. */
const INVITE_DELAY_MS = 40_000;

/** A client that misses this many pongs is dropped, as in the contract. */
const MISSED_PONGS_ALLOWED = 3;

const now = () => new Date().toISOString();
const later = (ms) => new Date(Date.now() + ms).toISOString();

// ---------------------------------------------------------------------------
// The little world the mock lives in
// ---------------------------------------------------------------------------

const user = (id, displayName, provider, providerName) => ({
  id,
  displayName,
  avatarUrl: null,
  provider,
  providerName,
  createdAt: "2026-01-01T00:00:00Z",
});

const users = {
  me: user("u_me", "You", "dev", "you"),
  kyle: user("u_kyle", "Kyle Katarn", "jkhub", "kyle_k"),
  jan: user("u_jan", "Jan Ors", "discord", "jan_ors"),
  mara: user("u_mara", "Mara Jade", "jkhub", "mara_j"),
  luke: user("u_luke", "Luke Skywalker", "jkhub", "luke_s"),
  dash: user("u_dash", "Dash Rendar", "discord", "dash_r"),
};

/** The two servers the scripted friend moves between. */
const SERVERS = [
  { serverAddress: "203.0.113.10:29070", serverName: "EU FFA Nightly" },
  { serverAddress: "198.51.100.7:29071", serverName: "JA+ Duel Arena" },
];

/** Three friends in the three states the screen groups by. */
const state = {
  friends: [
    {
      user: users.kyle,
      presence: {
        status: "in_game",
        ...SERVERS[0],
        clientName: "Everyday",
        since: later(-15 * 60_000),
      },
      friendsSince: "2026-03-04T12:00:00Z",
    },
    {
      user: users.jan,
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
      user: users.mara,
      presence: {
        status: "offline",
        serverAddress: null,
        serverName: null,
        clientName: null,
        since: later(-26 * 60 * 60_000),
      },
      friendsSince: "2025-12-24T22:10:00Z",
    },
  ],
  incoming: [
    { id: "r_incoming", from: users.luke, to: users.me, createdAt: later(-40 * 60_000) },
  ],
  outgoing: [
    { id: "r_outgoing", from: users.me, to: users.dash, createdAt: later(-2 * 60_000) },
  ],
  invites: [],
  presence: { status: "offline", serverAddress: null, serverName: null, clientName: null, since: now() },
};

let nextId = 1;
const id = (prefix) => `${prefix}_${nextId++}`;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * The real hub needs none of this: the launcher is not a browser origin, and
 * the contract says so. The mock allows everything because `npm run dev` puts
 * the same frontend on `http://localhost:14xx`, and reviewing the Friends
 * screen there is most of what this file is for.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-max-age": "86400",
};

const fail = (response, status, code, message) => {
  send(response, status, { error: { code, message } });
};

function send(response, status, body) {
  const text = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
    ...CORS,
  });
  response.end(text);
}

/** Reads a JSON body, or `{}` when there is none. */
async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/** Any non-empty bearer is a signed-in player here. */
const tokenOf = (request) => {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  const path = url.pathname;
  const method = request.method ?? "GET";
  console.log(`${method} ${path}`);

  if (method === "OPTIONS") {
    response.writeHead(204, CORS);
    response.end();
    return;
  }

  if (path === "/v1/dev/token" && method === "POST") {
    // Not in the contract: a shortcut so a developer can fill `hubToken`
    // without running the whole browser round-trip of the account slice.
    send(response, 200, { token: "0".repeat(63) + "1", user: users.me });
    return;
  }

  if (path === "/v1/dev/invite" && method === "POST") {
    // Also not in the contract. The scripted invitation arrives 40 s after a
    // socket connects, which is a long time to sit and look at a toast that
    // has not appeared yet.
    const invite = incomingInvite();
    state.invites.unshift(invite);
    broadcast("invite", { invite });
    send(response, 201, invite);
    return;
  }

  if (!tokenOf(request)) {
    fail(response, 401, "unauthorized", "This call needs a bearer token.");
    return;
  }

  if (path === "/v1/me" && method === "GET") {
    send(response, 200, { user: users.me, presence: state.presence });
    return;
  }

  if (path === "/v1/friends" && method === "GET") {
    send(response, 200, {
      friends: state.friends,
      incoming: state.incoming,
      outgoing: state.outgoing,
    });
    return;
  }

  if (path === "/v1/friends/requests" && method === "POST") {
    const payload = await body(request);
    const query = String(payload?.query ?? "").trim();
    if (!query) {
      fail(response, 400, "invalid", "Type a name to send a request to.");
      return;
    }
    if (state.friends.some((friend) => matches(friend.user, query))) {
      fail(response, 409, "conflict", `You are already friends with ${query}.`);
      return;
    }
    // The one case worth mocking properly: asking somebody who has already
    // asked you makes you friends on the spot, with a 200 instead of a 201.
    const pending = state.incoming.find((entry) => matches(entry.from, query));
    if (pending) {
      const friend = accept(pending.id);
      send(response, 200, { friend });
      return;
    }
    if (query.toLowerCase().includes("nobody")) {
      fail(response, 404, "not_found", `Nobody on JKNet is called ${query}.`);
      return;
    }
    const created = {
      id: id("r"),
      from: users.me,
      to: user(id("u"), query.replace(/^[a-z]+:/i, ""), "jkhub", query),
      createdAt: now(),
    };
    state.outgoing.push(created);
    send(response, 201, created);
    return;
  }

  const acceptMatch = path.match(/^\/v1\/friends\/requests\/([^/]+)\/accept$/);
  if (acceptMatch && method === "POST") {
    const friend = accept(acceptMatch[1]);
    if (!friend) {
      fail(response, 404, "not_found", "That request is gone.");
      return;
    }
    broadcast("friend.accepted", { friend });
    send(response, 200, friend);
    return;
  }

  const requestMatch = path.match(/^\/v1\/friends\/requests\/([^/]+)$/);
  if (requestMatch && method === "DELETE") {
    const before = state.incoming.length + state.outgoing.length;
    state.incoming = state.incoming.filter((entry) => entry.id !== requestMatch[1]);
    state.outgoing = state.outgoing.filter((entry) => entry.id !== requestMatch[1]);
    if (before === state.incoming.length + state.outgoing.length) {
      fail(response, 404, "not_found", "That request is gone.");
      return;
    }
    send(response, 204);
    return;
  }

  const friendMatch = path.match(/^\/v1\/friends\/([^/]+)$/);
  if (friendMatch && method === "DELETE") {
    const before = state.friends.length;
    state.friends = state.friends.filter((friend) => friend.user.id !== friendMatch[1]);
    if (before === state.friends.length) {
      fail(response, 404, "not_found", "You are not friends with them.");
      return;
    }
    broadcast("friend.removed", { userId: friendMatch[1] });
    send(response, 204);
    return;
  }

  if (path === "/v1/presence" && method === "PUT") {
    const payload = await body(request);
    if (!payload || !["online", "in_game"].includes(payload.status)) {
      fail(response, 400, "invalid", "status must be online or in_game.");
      return;
    }
    state.presence = {
      status: payload.status,
      serverAddress: payload.serverAddress ?? null,
      serverName: payload.serverName ?? null,
      clientName: payload.clientName ?? null,
      since: now(),
    };
    console.log(`  presence -> ${state.presence.status} ${state.presence.serverAddress ?? ""}`);
    send(response, 200, state.presence);
    return;
  }

  if (path === "/v1/invites" && method === "GET") {
    send(response, 200, state.invites);
    return;
  }

  if (path === "/v1/invites" && method === "POST") {
    const payload = await body(request);
    if (!payload?.toUserId || !payload?.serverAddress) {
      fail(response, 400, "invalid", "An invite needs a friend and a server.");
      return;
    }
    const invite = {
      id: id("i"),
      from: users.me,
      serverAddress: payload.serverAddress,
      serverName: payload.serverName ?? null,
      message: payload.message ?? null,
      createdAt: now(),
      expiresAt: later(10 * 60_000),
    };
    console.log(`  invite -> ${payload.toUserId} at ${invite.serverAddress}`);
    send(response, 201, invite);
    return;
  }

  const inviteMatch = path.match(/^\/v1\/invites\/([^/]+)$/);
  if (inviteMatch && method === "DELETE") {
    state.invites = state.invites.filter((invite) => invite.id !== inviteMatch[1]);
    send(response, 204);
    return;
  }

  fail(response, 404, "not_found", `No route for ${method} ${path}.`);
});

/** The invitation the scripted friend sends. */
function incomingInvite() {
  return {
    id: id("i"),
    from: users.kyle,
    serverAddress: SERVERS[0].serverAddress,
    serverName: SERVERS[0].serverName,
    message: "Duel?",
    createdAt: now(),
    expiresAt: later(10 * 60_000),
  };
}

/** Matches a display name, a `provider:name` or an id, as the hub does. */
function matches(person, query) {
  const wanted = query.trim().toLowerCase();
  return (
    person.id.toLowerCase() === wanted ||
    person.displayName.toLowerCase() === wanted ||
    person.providerName.toLowerCase() === wanted ||
    `${person.provider}:${person.providerName}`.toLowerCase() === wanted
  );
}

/** Turns an incoming request into a friendship. */
function accept(requestId) {
  const index = state.incoming.findIndex((entry) => entry.id === requestId);
  if (index === -1) return null;
  const [entry] = state.incoming.splice(index, 1);
  const friend = {
    user: entry.from,
    presence: {
      status: "online",
      serverAddress: null,
      serverName: null,
      clientName: null,
      since: now(),
    },
    friendsSince: now(),
  };
  state.friends.push(friend);
  return friend;
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

  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
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
    const kyle = state.friends.find((friend) => friend.user.id === users.kyle.id);
    if (kyle) {
      const next = SERVERS[Math.floor(Math.random() * SERVERS.length)];
      kyle.presence = {
        status: "in_game",
        ...next,
        clientName: "Everyday",
        since: now(),
      };
      write(socket, frame("presence.updated", { userId: kyle.user.id, presence: kyle.presence }));
    }
  }, PING_INTERVAL_MS);

  const invite = setTimeout(() => {
    const entry = incomingInvite();
    state.invites.unshift(entry);
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
  encode(0x1, Buffer.from(JSON.stringify({ type, payload, at: now() }), "utf8"));

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

server.listen(PORT, HOST, () => {
  console.log(`mock hub on http://${HOST}:${PORT}`);
  console.log(`  friends: ${state.friends.map((f) => f.user.displayName).join(", ")}`);
  console.log(`  a ping every ${PING_INTERVAL_MS / 1000} s, an invite after ${INVITE_DELAY_MS / 1000} s`);
});
