/**
 * The fakes behind the catalogs of the e2e service, all on 127.0.0.1: a
 * master server and game servers of each game over UDP for the server list
 * (spec 1.12), a JKHub site over HTTP for the file pages the catalog links
 * to, and a seeded JKHub index (spec 1.13). No e2e run reaches a real master
 * server or jkhub.org.
 *
 * The master and game servers answer the way `jknet-online/tests/servers.rs`
 * fakes them: `getservers <protocol>` with the listed addresses and `\EOT`,
 * `getinfo` with an info string, `getstatus` with a player list. The JKHub
 * index is written before the service starts, dated now, so the service's
 * refresh plans nothing for Jedi Academy; Jedi Outcast has no index, so its
 * catalog answers `catalog_not_ready`, and the one crawl the service tries
 * for it stops at the fake site's `404` for the category index.
 */

import { createSocket, type Socket } from "node:dgram";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

const OOB = Buffer.from([0xff, 0xff, 0xff, 0xff]);

/** One fake game server of the list. */
export interface FakeServerSpec {
  /** Stable name for the spec to find the row by. */
  key: "duel" | "vanilla" | "bots" | "empty" | "outcast";
  game: "ja" | "jo";
  /** The info string after `\challenge\<c>`. */
  info: string;
  /** Lines of the player list `getstatus` answers with, or none. */
  players?: string;
  /** What the row shows, for the spec. */
  clean: string;
  map: string;
  gametype: number;
}

/** A fake game server as the spec reads it: where it listens. */
export interface FakeServer extends FakeServerSpec {
  address: string;
}

/**
 * The servers of the list. Names are unique words so the spec finds each
 * row by its text.
 *
 * - `duel`: publishes `g_humanplayers`: 3 people and 2 bots, a password, japlus.
 * - `vanilla`: hides `g_humanplayers`; its player list says 2 people and a bot.
 * - `bots`: four clients, all bots: the list hides it by default.
 * - `empty`: nobody on it.
 * - `outcast`: a Jedi Outcast 1.04 server.
 */
export const FAKE_SERVERS: readonly FakeServerSpec[] = [
  {
    key: "duel",
    game: "ja",
    info: "\\hostname\\^1Kyber ^7Duel Hall\\mapname\\mp/duel1\\clients\\5\\g_humanplayers\\3\\sv_maxclients\\24\\gametype\\3\\needpass\\1\\game\\japlus\\protocol\\26",
    clean: "Kyber Duel Hall",
    map: "mp/duel1",
    gametype: 3,
  },
  {
    key: "vanilla",
    game: "ja",
    info: "\\hostname\\^2Vanilla ^7Tavern\\mapname\\mp/ffa3\\clients\\3\\sv_maxclients\\16\\gametype\\0\\protocol\\26",
    players: '12 50 "^1Kyle"\n7 70 "Jan"\n0 0 "Droid"\n',
    clean: "Vanilla Tavern",
    map: "mp/ffa3",
    gametype: 0,
  },
  {
    key: "bots",
    game: "ja",
    info: "\\hostname\\^3Droid ^7Arena\\mapname\\mp/ffa2\\clients\\4\\g_humanplayers\\0\\sv_maxclients\\16\\gametype\\0\\protocol\\26",
    clean: "Droid Arena",
    map: "mp/ffa2",
    gametype: 0,
  },
  {
    key: "empty",
    game: "ja",
    info: "\\hostname\\^4Empty ^7Flags\\mapname\\mp/ctf1\\clients\\0\\sv_maxclients\\20\\gametype\\8\\protocol\\26",
    clean: "Empty Flags",
    map: "mp/ctf1",
    gametype: 8,
  },
  {
    key: "outcast",
    game: "jo",
    info: "\\hostname\\^6Outcast ^7Bespin\\mapname\\ffa_bespin\\clients\\2\\g_humanplayers\\2\\sv_maxclients\\12\\gametype\\0\\protocol\\16",
    clean: "Outcast Bespin",
    map: "ffa_bespin",
    gametype: 0,
  },
];

function bind(): Promise<{ socket: Socket; port: number }> {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      socket.off("error", reject);
      // An ICMP "port unreachable" of an earlier reply arrives as an error
      // on Windows; a fake reads on.
      socket.on("error", () => undefined);
      resolve({ socket, port: socket.address().port });
    });
  });
}

/** The command word and its argument of an out-of-band payload. */
function command(datagram: Buffer): { word: string; rest: string } | null {
  if (datagram.length < 4 || !datagram.subarray(0, 4).equals(OOB)) return null;
  const text = datagram.subarray(4).toString("latin1");
  const match = /^([A-Za-z]+)[ \n]?([\s\S]*)$/.exec(text);
  return match === null ? null : { word: match[1], rest: match[2] };
}

async function fakeGameServer(spec: FakeServerSpec): Promise<{ server: FakeServer; socket: Socket }> {
  const { socket, port } = await bind();
  socket.on("message", (datagram, from) => {
    const asked = command(datagram);
    if (asked === null) return;
    const challenge = asked.rest.trim();
    let reply: string;
    if (asked.word === "getinfo") {
      reply = `infoResponse\n\\challenge\\${challenge}${spec.info}`;
    } else if (asked.word === "getstatus") {
      if (spec.players === undefined) return;
      reply = `statusResponse\n\\challenge\\${challenge}\\sv_hostname\\Fake\n${spec.players}`;
    } else {
      return;
    }
    socket.send(Buffer.concat([OOB, Buffer.from(reply, "latin1")]), from.port, from.address);
  });
  return { server: { ...spec, address: `127.0.0.1:${port}` }, socket };
}

/** A master that lists `listed` for the protocols it knows and nothing for the rest. */
async function fakeMaster(protocols: readonly number[], listed: readonly string[]): Promise<{ address: string; socket: Socket }> {
  const { socket, port } = await bind();
  socket.on("message", (datagram, from) => {
    if (datagram.length < 4 || !datagram.subarray(0, 4).equals(OOB)) return;
    const match = /^getservers (\d+)/.exec(datagram.subarray(4).toString("latin1"));
    if (match === null) return;
    const parts: Buffer[] = [OOB, Buffer.from("getserversResponse", "latin1")];
    if (protocols.includes(Number(match[1]))) {
      for (const address of listed) {
        const [ip, portText] = address.split(":");
        const record = Buffer.alloc(7);
        record[0] = 0x5c;
        ip.split(".").forEach((octet, index) => {
          record[1 + index] = Number(octet);
        });
        record.writeUInt16BE(Number(portText), 5);
        parts.push(record);
      }
    }
    parts.push(Buffer.from("\\EOT\0\0\0", "latin1"));
    socket.send(Buffer.concat(parts), from.port, from.address);
  });
  return { address: `127.0.0.1:${port}`, socket };
}

export interface ServerFakes {
  mastersJa: string;
  mastersJo: string;
  servers: FakeServer[];
  stop(): Promise<void>;
}

/** The masters and game servers of both games. */
export async function startServerFakes(): Promise<ServerFakes> {
  const started = await Promise.all(FAKE_SERVERS.map((spec) => fakeGameServer(spec)));
  const servers = started.map((entry) => entry.server);
  const listed = (game: "ja" | "jo") => servers.filter((server) => server.game === game).map((server) => server.address);
  const masterJa = await fakeMaster([26], listed("ja"));
  const masterJo = await fakeMaster([16], listed("jo"));
  const sockets = [...started.map((entry) => entry.socket), masterJa.socket, masterJo.socket];
  return {
    mastersJa: masterJa.address,
    mastersJo: masterJo.address,
    servers,
    stop: async () => {
      await Promise.all(sockets.map((socket) => new Promise<void>((resolve) => socket.close(() => resolve()))));
    },
  };
}

// ---------------------------------------------------------------------------
// JKHub
// ---------------------------------------------------------------------------

/** One file of the seeded Jedi Academy index. */
export interface SeedFile {
  id: number;
  slug: string;
  title: string;
  author: string;
  /** A site category of the eight sections (`jknet-online/src/jkhub/sections.rs`). */
  categoryId: number;
  description: string;
  downloads: number;
  updatedAt: string;
  tags: string[];
  rating: { value: number; count: number } | null;
}

/** The site categories of Jedi Academy the seed spreads over, and their sections. */
const SEED_CATEGORIES = [13, 28, 24, 4, 23, 36, 6, 30, 38];

/** Files seeded into the Jedi Academy index: two to search for, and 28 more to page through. */
export const SEED_FILES: readonly SeedFile[] = [
  {
    id: 5001,
    slug: "kyber-crystal-hilts",
    title: "Kyber Crystal Hilts",
    author: "Circa",
    categoryId: 24,
    description: "Twelve hilts cut from kyber crystals, each with its own blade sound.",
    downloads: 4200,
    updatedAt: "2026-09-20T10:00:00Z",
    tags: ["hilts", "sabers"],
    rating: { value: 4.5, count: 12 },
  },
  {
    id: 5002,
    slug: "kyber-temple-duel",
    title: "Kyber Temple Duel",
    author: "Szico VII",
    categoryId: 28,
    description: "A duel arena inside a kyber temple.",
    downloads: 900,
    updatedAt: "2026-09-10T10:00:00Z",
    tags: ["duel"],
    rating: null,
  },
  ...Array.from({ length: 28 }, (_, index): SeedFile => {
    const number = String(index + 3).padStart(2, "0");
    return {
      id: 5003 + index,
      slug: `fixture-file-${number}`,
      title: `Fixture File ${number}`,
      author: "Fixture Author",
      categoryId: SEED_CATEGORIES[index % SEED_CATEGORIES.length],
      description: `Fixture file number ${number} of the e2e catalog.`,
      downloads: 100 + index,
      updatedAt: `2026-08-${String(28 - (index % 28)).padStart(2, "0")}T10:00:00Z`,
      tags: [],
      rating: null,
    };
  }),
];

/**
 * Writes the Jedi Academy index into the catalog folder, dated now, in the
 * launcher's format (`INDEX_VERSION` 2). No thumbnail: the service keeps only
 * `https://jkhub.org` ones, and the browser would load them from the real site.
 */
export function seedJkhubCatalog(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const index = {
    version: 2,
    game: "ja",
    builtAt: stamp,
    updatedAt: stamp,
    updatedUnix: Math.floor(now.getTime() / 1000),
    files: SEED_FILES.map((file) => ({
      id: file.id,
      slug: file.slug,
      title: file.title,
      authorName: file.author,
      authorUrl: null,
      categoryId: file.categoryId,
      game: "ja",
      thumbnailUrl: null,
      description: file.description,
      downloads: file.downloads,
      submittedAt: null,
      updatedAt: file.updatedAt,
      tags: file.tags,
      rating: file.rating,
    })),
  };
  writeFileSync(join(dir, "index-ja.json"), JSON.stringify(index));
}

export interface JkhubFake {
  base: string;
  stop(): Promise<void>;
}

/**
 * jkhub.org on 127.0.0.1: a plain page for every file page
 * (`/files/file/<id>-<slug>/`), which **Open on JKHub** opens, and `404` for
 * everything else — the category index included, so a crawl stops at once.
 */
export async function startJkhubFake(): Promise<JkhubFake> {
  const server: Server = createServer((request, response) => {
    const match = /^\/files\/file\/(\d+)-([a-z0-9-]+)\/$/.exec(request.url ?? "");
    if (request.method === "GET" && match !== null) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>JKHub file ${match[1]}</title>` +
          `<link rel="icon" href="data:,"></head><body><h1>JKHub file ${match[1]}</h1></body></html>`,
      );
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** What `global-setup.ts` hands the workers in `JKNET_E2E_CATALOG`. */
export interface CatalogFakesInfo {
  servers: FakeServer[];
  jkhubBase: string;
}

/** The fakes of this run, as the workers read them. */
export function catalogFakes(): CatalogFakesInfo {
  const raw = process.env.JKNET_E2E_CATALOG;
  if (raw === undefined || raw === "") throw new Error("JKNET_E2E_CATALOG is not set: the fakes start in global-setup.ts");
  return JSON.parse(raw) as CatalogFakesInfo;
}
