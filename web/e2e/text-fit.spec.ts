/**
 * Text fits its controls on every screen of the web app, in every language,
 * on a narrow phone and on a wide screen.
 *
 * One test per language signs a player in and seeds what the screens draw:
 * friends with the longest names the service takes, a request each way, a
 * friend who hosts a server with a chat and sends an invite, a friend in a
 * game, a second device of the player, a direct chat and a group with a long
 * title, long messages, cards and two pictures (one over the size that
 * downloads by itself), a group invitation, a bundle and a community server
 * page. It then opens every screen — the sign-in, its error and the page of
 * a sign-in finished elsewhere signed out, then chats, threads, group info,
 * friends, requests, settings, the catalogs, the emoji sheet, the picture
 * viewer and five dialogs — at 320, 360 and 390 px (the phone layout, the
 * drawer open too) and at 1280 px (the wide layout), and the chats and the
 * threads once more on a touch screen, a tapped message with its tools too.
 * On each it runs `text-fit-detector.ts`: text pressed against the edges of
 * its button, card, row, chip or banner; text cut off or squeezed to a word a
 * line; a box sticking out of its card; a pane or the page scrolling
 * sideways; text drawn over text or an icon. The app is loaded once after
 * seeding and then navigates itself, as a link would.
 *
 * Every hit is written as JSON, with a marked crop of each distinct one, to
 * `JKNET_TEXT_FIT_OUT` (default `web/e2e/dist/text-fit`): `hits/<lang>.json`
 * per test and `rendered-hits.json` merged over all of them, with what was
 * measured and how in `coverage`. `JKNET_TEXT_FIT_SCREENS=1` also keeps a
 * screenshot of every screen at every width.
 *
 * The test fails on what a layout audit fixed. Anywhere, on every screen:
 * text drawn past the border of its box or touching an edge of it a reader
 * sees (less than 1 px between them), a box or text sticking out of its card
 * or the screen, a pane scrolling sideways, text over text or an icon, a
 * sentence squeezed to a word a line, and on the wide screen a rail tile
 * wider than the others or a rail label within 4 px of its tile's sides
 * (`railTilesEven`). Text cut off (`truncate`, a clamp) is often the design,
 * a name in a dense row, so it fails only inside the elements a screen's
 * `gates` name, the ones that once cut a sentence, a label or a name with
 * room to wrap; there an empty field's placeholder has to fit as well. On
 * the sign-in the provider buttons, where a fixed height once pressed a
 * wrapped note against the border (dc73949), keep their text off the border,
 * and the gate still fails the buttons as they were.
 *
 * Two runs write the same hits; only the service's ids in `route` and the
 * clock times in `control` differ. What is drawn does not depend on the run:
 * a language's accounts, bundle and server page carry letters of its own,
 * the same letters in every language in another order (see `letters`); the
 * accounts are made one after another and the group a second after the
 * direct chat, so members and chats keep their order; and a catalog shows
 * the language's own entry only, whichever test published first. The dates
 * and times come from the service's clock and cannot move a hit (see
 * `test.use` below), nor can the ports the system hands the fake game
 * servers of `catalog-fakes.ts`: five digits in the mono face.
 *
 * The run is the edge project's alone (`playwright.config.ts` leaves this
 * file out of the others): the widths and languages are the matrix here.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

import type { Locator, Page } from "@playwright/test";

import { catalogFakes } from "./catalog-fakes.ts";
import {
  backFromService,
  BASE,
  expect,
  launcherSignIn,
  ownAddress,
  SERVICE,
  sharedCatalog,
  test,
  userIdOf,
  webCatalog,
  type LauncherClient,
} from "./fixtures.ts";
import { tokenOf } from "./push-fixtures.ts";
import { detectTextFit, type TextFitHit, type TextFitOptions } from "./text-fit-detector.ts";

// Nothing here needs the worker; `pwa.spec.ts` covers it.
test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "parallel" });

const LOCALES = {
  en: "en-US",
  ru: "ru-RU",
  uk: "uk-UA",
  de: "de-DE",
  es: "es-ES",
  fr: "fr-FR",
  pl: "pl-PL",
  hu: "hu-HU",
} as const;
type Language = keyof typeof LOCALES;
const LANGUAGES = Object.keys(LOCALES) as Language[];

const PHONE_WIDTHS = [320, 360, 390];
const WIDE_WIDTH = 1280;
const WIDTHS = [...PHONE_WIDTHS, WIDE_WIDTH];
const PHONE_HEIGHT = 740;
const WIDE_HEIGHT = 800;
/** The least room between text and the edge of its box: 4 px above and below, 6 px to the sides. */
const ROOM: TextFitOptions = { vertical: 4, horizontal: 6 };
/** At most this many crops per language: one per distinct hit and layout. */
const SHOTS_PER_LANGUAGE = 200;

const OUT = process.env.JKNET_TEXT_FIT_OUT ?? fileURLToPath(new URL("./dist/text-fit", import.meta.url));
/** `JKNET_TEXT_FIT_SCREENS=1` also keeps a screenshot of every screen at every width, for reading by eye. */
const SCREENS = process.env.JKNET_TEXT_FIT_SCREENS === "1";

interface HitRecord extends TextFitHit {
  language: Language;
  width: number;
  screen: string;
  route: string;
  shot?: string;
}

interface Coverage {
  screen: string;
  path: string;
  width: number;
  /** `ok`, or why the screen was measured without its data (or not at all). */
  status: string;
  hits: number;
}

// ---------------------------------------------------------------------------
// The service: accounts, friends, chats, catalogs.
// ---------------------------------------------------------------------------

/** One call to the e2e service with a player's token; answers the JSON body. */
async function api<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${SERVICE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  expect(response.ok, `${method} ${path}: ${response.status} ${text}`).toBe(true);
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A client id as the apps make one: a ULID. It keys a sent message against
 * a resend and never shows, so it may differ between runs.
 */
function ulid(): string {
  let time = Date.now();
  let head = "";
  for (let index = 0; index < 10; index += 1) {
    head = CROCKFORD[time % 32] + head;
    time = Math.floor(time / 32);
  }
  let tail = "";
  for (let index = 0; index < 16; index += 1) tail += CROCKFORD[Math.floor(Math.random() * 32)];
  return head + tail;
}

/** The `index`-th order of `items` (0 keeps them as they are), for up to `items.length`! orders. */
function arrangement(items: string, index: number): string {
  const pool = [...items];
  const factorial = (count: number): number => (count <= 1 ? 1 : count * factorial(count - 1));
  expect(index, `an order of "${items}"`).toBeLessThan(factorial(pool.length));
  let rest = index;
  let text = "";
  for (let left = pool.length; left > 0; left -= 1) {
    const block = factorial(left - 1);
    text += pool.splice(Math.floor(rest / block), 1)[0];
    rest %= block;
  }
  return text;
}

/**
 * Letters that no face of the app (Inter, Chakra Petch, Exo 2, JetBrains
 * Mono) kerns against each other, a space or an ellipsis: any order of them
 * is drawn equally wide.
 */
const EVEN_LETTERS = "adhilm";

/**
 * `count` letters, 4 to 6, that tell this language's long names from the
 * other languages' in the service the tests share: the same letters in an
 * order of the language's own. A name is then as wide, and cut at the same
 * place, in every run and every language.
 */
function letters(language: Language, count: number): string {
  expect(count, "enough letters for eight orders").toBeGreaterThanOrEqual(4);
  return arrangement(EVEN_LETTERS.slice(0, count), LANGUAGES.indexOf(language));
}

/**
 * The port of the language's community server: the digits 1 to 4 in its own
 * order after a 6, from 61234 up, so no two languages share an address and
 * none meets the random ports of `catalog.spec.ts` (20000 to 59999).
 */
function communityPort(language: Language): number {
  return Number(`6${arrangement("1234", LANGUAGES.indexOf(language))}`);
}

/** The language's `jknet_session` of a private server: 16 hex characters. */
function sessionId(language: Language): string {
  return createHash("sha256").update(`text-fit hosting ${language}`).digest("hex").slice(0, 16);
}

/** The database file of the e2e service, from the environment `global-setup.ts` hands the workers. */
function serviceDatabase(): string {
  const service = JSON.parse(process.env.JKNET_E2E_SERVICE ?? "{}") as { env?: Record<string, string> };
  const url = service.env?.JKNET_ONLINE_DATABASE_URL ?? "";
  expect(url, "the e2e service's database").toMatch(/^sqlite:\/\//);
  return url.slice("sqlite://".length).replace(/\?.*$/, "");
}

async function sendMessage(token: string, conversationId: string, body: string, cards: unknown[] = []): Promise<void> {
  await api(token, "POST", `/v1/chat/conversations/${encodeURIComponent(conversationId)}/messages`, { clientId: ulid(), body, cards });
}

/** Waits until the clock of the service, which counts whole seconds, has passed the second of now. */
async function nextSecond(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1_050 - (Date.now() % 1_000)));
}

/** Asks `name` to be friends; answers the request's id. */
async function requestFriendship(token: string, name: string): Promise<string> {
  const request = await api<{ id: string }>(token, "POST", "/v1/friends/requests", { query: name });
  return request.id;
}

/** A long message, with a link that has no place to break. */
const LONG_MESSAGE =
  "Tonight we run the clan tournament on the duel server: three rounds of best-of-five, sabers only, no force powers " +
  "except jump and speed, and the winner of each bracket plays the defending champion before midnight. Bring your " +
  "own configs, check your binds, and read the rules on the community page before you join. The recording goes here: " +
  "https://server.example.com/recordings/clan-tournament-final-round-duel-hall-extended-edition-2026-09-30.dm_26";

/** 64 characters, the most a group title holds. */
const LONG_GROUP_TITLE = "Clan night: Kyber Duel Hall weekend tournament planning crew #26";
/** The picture that comes down by itself, and the one over the 10 MiB that waits for **Show picture**. */
const PICTURE = "duel.png";
const BIG_PICTURE = "duel-hall-panorama.png";
/** The group the host invites the player to; the invitation also shows as a toast. */
const INVITED_GROUP_TITLE = "Saturday bracket rehearsal";

/** A PNG of `width` × `height` px in one colour, grown to `size` bytes by a private chunk when asked. */
function png(width: number, height: number, size = 0): Buffer<ArrayBuffer> {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // 8 bits a channel
  header.writeUInt8(2, 9); // RGB
  const row = Buffer.alloc(1 + width * 3, 0x46);
  row[0] = 0; // no filter
  const parts = [Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row))))];
  const used = parts.reduce((sum, part) => sum + part.length, 0) + 12;
  if (size > used + 12) parts.push(chunk("jnKt", Buffer.alloc(size - used - 12)));
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** Sends a picture as the web app does: registered, its bytes uploaded, then a message that carries it. */
async function sendPicture(token: string, conversationId: string, name: string, bytes: Buffer<ArrayBuffer>, width: number, height: number): Promise<void> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const registered = await api<{ file: { id: string }; needsUpload?: boolean }>(token, "POST", "/v1/chat/files", {
    conversationId,
    name,
    size: bytes.length,
    sha256,
    meta: { origin: "file", width, height },
  });
  if (registered.needsUpload !== false) {
    const upload = await fetch(`${SERVICE}/v1/chat/files/${encodeURIComponent(registered.file.id)}/content`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-length": String(bytes.length) },
      body: bytes,
    });
    expect(upload.ok, `the picture ${name} (${upload.status})`).toBe(true);
  }
  await api(token, "POST", `/v1/chat/conversations/${encodeURIComponent(conversationId)}/messages`, {
    clientId: ulid(),
    body: "",
    cards: [],
    fileIds: [registered.file.id],
  });
}

interface Seeded {
  me: { name: string; id: string; token: string };
  host: LauncherClient & { name: string };
  gamer: LauncherClient & { name: string };
  direct: string;
  group: string;
  /** The group the host invites the player to: the player asks before being added. */
  invited: string;
  bundleId: string;
  bundleName: string;
  communityId: string;
  communityName: string;
  duelAddress: string;
  stop(): void;
}

/**
 * Everything the screens draw, through the service's API: the player of
 * `page` with a launcher as a second device, two friends, a request each
 * way, a hosted server with its chat and an invite, a friend in a game, a
 * direct chat with messages, cards and pictures, a group, an invitation to
 * another group, a bundle and a community server page.
 */
async function seed(page: Page, language: Language, myName: string): Promise<Seeded> {
  const token = await tokenOf(page);
  const myId = await userIdOf(page);
  // 24 characters each, the most the sign-in takes.
  const hostName = `Maximilian Wolfgang ${letters(language, 4)}`;
  const gamerName = `Wilhelmina Wojciech ${letters(language, 4)}`;
  const askerName = `Konstantinos Papad ${letters(language, 5)}`;
  const askedName = `Szczepan Brzeczysz ${letters(language, 5)}`;
  // One after the other: an account's id grows with the time it is made, and
  // members who join a group in the same second are listed by it.
  const host = await launcherSignIn(hostName);
  const gamer = await launcherSignIn(gamerName);
  const asker = await launcherSignIn(askerName);
  // The asked player, and a launcher of the player: a second device to sign out.
  await launcherSignIn(askedName);
  await launcherSignIn(myName);

  // Two friends, one request to the player, one from the player.
  for (const [friend, name] of [[host, hostName], [gamer, gamerName]] as const) {
    const id = await requestFriendship(token, name);
    await api(friend.token, "POST", `/v1/friends/requests/${id}/accept`, {});
  }
  await requestFriendship(asker.token, myName);
  await requestFriendship(token, askedName);

  // The host's private server, with a chat open to the web and an invite.
  const lan = "192.168.1.20:29070";
  const hosting = {
    sessionId: sessionId(language),
    game: "ja",
    mod: "japlus",
    map: "mp/ffa3",
    gametype: 0,
    players: 3,
    maxPlayers: 16,
    joinPolicy: "friends",
    lanAddresses: [lan],
  };
  const beatHost = () => api(host.token, "PUT", "/v1/presence", { status: "online", hosting });
  const beatGamer = () =>
    api(gamer.token, "PUT", "/v1/presence", {
      status: "in_game",
      serverName: "Kyber Duel Hall: Extended Tournament Edition",
      serverAddress: "203.0.113.7:29070",
    });
  await Promise.all([beatHost(), beatGamer()]);
  const timer = setInterval(() => {
    void beatHost().catch(() => undefined);
    void beatGamer().catch(() => undefined);
  }, 20_000);
  const response = await fetch(`${SERVICE}/v1/chat/servers/${hosting.sessionId}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${host.token}` },
  });
  expect(response.status, "the hosted server's chat opens").toBe(201);
  await api(host.token, "POST", "/v1/invites", {
    toUserId: myId,
    serverAddress: lan,
    serverName: "Duel night with the whole clan and the guests",
    message: "Come over after work: we start with the warm-up duels, then the bracket, then free for all until late.",
    hosting,
  });

  // A bundle and a community server page, for the catalogs and the cards.
  const bundleName = `Kyber Duel Pack Extended Tournament Edition ${letters(language, 4)}`;
  const bundle = await publishBundle(token, bundleName);
  const communityName = `Kyber Duel Hall Community Tournament Server ${letters(language, 4)}`;
  const communityId = await publishCommunityServer(token, myId, communityName, `1.1.1.1:${communityPort(language)}`);

  // The direct chat with the host: short, long, cards, an invite card.
  const direct = (await api<{ id: string }>(host.token, "PUT", `/v1/chat/direct/${encodeURIComponent(myId)}`)).id;
  await sendMessage(host.token, direct, "Ready for the duel tonight?");
  await sendMessage(host.token, direct, LONG_MESSAGE);
  await sendMessage(token, direct, "Yes. I am bringing the new hilts and my whole config, see you on the server.");
  await sendMessage(host.token, direct, "Everything for tonight:", [
    {
      type: "server",
      v: 1,
      fallbackText: "Kyber Duel Hall",
      address: "203.0.113.7:29070",
      name: "Kyber Duel Hall: Extended Tournament Edition",
      game: "ja",
      map: "mp/duel1",
      gametype: 3,
      mod: "japlus",
    },
    { type: "jkhubMod", v: 1, fallbackText: "Kyber Crystal Hilts", fileId: 5001, slug: "kyber-crystal-hilts", title: "Kyber Crystal Hilts", game: "ja" },
    { type: "map", v: 1, fallbackText: "mp/ffa3", game: "ja", name: "mp/ffa3", title: "Rift Sanctuary" },
    {
      type: "bind",
      v: 1,
      fallbackText: "Two binds",
      binds: [
        { key: "MOUSE3", command: "saberAttackCycle" },
        { key: "x", command: "say Good fight, well played everyone, see you in the next round!" },
      ],
    },
    { type: "config", v: 1, fallbackText: "duel-settings-for-tournament.cfg", name: "duel-settings-for-tournament.cfg", text: "seta cg_fov 97\nseta com_maxfps 125\n" },
  ]);
  await sendMessage(host.token, direct, "And the rest:", [
    { type: "bundle", v: 1, fallbackText: bundleName, bundleId: bundle.id, slug: bundle.slug, name: bundleName, game: "ja" },
    {
      type: "profile",
      v: 1,
      fallbackText: "My duel profile",
      nickname: "Maximilian the Relentless",
      model: "kyle/default",
      saber1: "single_1",
      color1: "blue",
    },
    { type: "hostInvite", v: 1, fallbackText: "Join my server", sessionId: hosting.sessionId, name: "Duel night with the whole clan" },
  ]);
  await sendPicture(host.token, direct, PICTURE, png(480, 270), 480, 270);
  await sendPicture(host.token, direct, BIG_PICTURE, png(64, 36, Math.round(10.5 * 1024 * 1024)), 1600, 900);

  // The group of the three, with a long title, newer than the direct chat:
  // the service stamps whole seconds, and chats of the same second are listed
  // by their ids, which differ from run to run.
  await nextSecond();
  const created = await api<{ conversation: { id: string } }>(token, "POST", "/v1/chat/groups", {
    clientId: ulid(),
    title: LONG_GROUP_TITLE,
    memberIds: [host.userId, gamer.userId],
  });
  const group = created.conversation.id;
  await sendMessage(token, group, "Who is in for the clan night on Saturday?");
  await sendMessage(host.token, group, LONG_MESSAGE);
  await sendMessage(gamer.token, group, "Count me in, but I join late: the ferry is at nine.");

  // The player asks before being added to a group: the host's group is an invitation.
  await api(token, "PATCH", "/v1/chat/settings", { groupAdd: "ask" });
  const invitedTo = await api<{ conversation: { id: string } }>(host.token, "POST", "/v1/chat/groups", {
    clientId: ulid(),
    title: INVITED_GROUP_TITLE,
    memberIds: [myId],
  });

  const duel = catalogFakes().servers.find((server) => server.key === "duel");
  return {
    me: { name: myName, id: myId, token },
    host: { ...host, name: hostName },
    gamer: { ...gamer, name: gamerName },
    direct,
    group,
    invited: invitedTo.conversation.id,
    bundleId: bundle.id,
    bundleName,
    communityId,
    communityName,
    duelAddress: duel?.address ?? "127.0.0.1:29070",
    stop: () => clearInterval(timer),
  };
}

/** A published bundle of Jedi Academy with one cfg file of its own and long texts. */
async function publishBundle(token: string, name: string): Promise<{ id: string; slug: string }> {
  const file = Buffer.from(`// ${name}\nseta cg_fov 97\n`);
  const sha256 = createHash("sha256").update(file).digest("hex");
  const bundle = await api<{ id: string; slug?: string }>(token, "POST", "/v1/bundles", {
    name,
    summary:
      "Everything a duelist needs for the tournament weekend: the hilts, the arena maps, the binds and a tuned config, " +
      "tested on the community servers.",
    description:
      `The **${name}** bundle: one client for duels, with the configs the finalists used.\n\n` +
      "It installs next to your other clients and changes nothing else.",
    game: "ja",
    tags: ["duel", "sabers", "competitive-tournament", "community-favourites"],
  });
  const manifest = {
    schema: 2,
    game: "ja",
    components: [
      {
        id: "mp",
        label: "Multiplayer tournament client",
        engine: { engineId: "eternaljk", releaseTag: null },
        modes: ["multiplayer"],
        fsGame: null,
        launchArgs: "",
        overlay: { files: [], remove: [] },
        files: [{ root: "home", path: "base/autoexec_duel_tournament.cfg", size: file.length, sha256, source: { kind: "blob" } }],
        configs: [{ name: "Tournament binds", text: "bind x say hi\n", priority: 0 }],
      },
    ],
    shared: { files: [], configs: [] },
  };
  const created = await api<{ version: { id: string } }>(token, "POST", `/v1/bundles/${bundle.id}/versions`, {
    label: "1.0 tournament",
    changelog: "First release for the tournament weekend",
    manifest,
  });
  const upload = await fetch(`${SERVICE}/v1/blobs/${sha256}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-length": String(file.length) },
    body: file,
  });
  expect(upload.ok, `the bundle's file (${upload.status})`).toBe(true);
  await api(token, "POST", `/v1/bundles/${bundle.id}/versions/${created.version.id}/publish`, {});
  const read = await api<{ slug?: string; bundle?: { slug?: string } }>(token, "GET", `/v1/bundles/${bundle.id}`);
  return { id: bundle.id, slug: read.slug ?? read.bundle?.slug ?? bundle.slug ?? "kyber-duel-pack" };
}

/**
 * A community server page with an owner, long texts and a recommended JKHub
 * file. The owner is set in the test database, as an administrator's
 * approval would; the address is never contacted.
 */
async function publishCommunityServer(token: string, ownerId: string, name: string, address: string): Promise<string> {
  const created = await api<{ id: string; revision: number }>(token, "POST", "/v1/community/servers", { name, address, game: "ja" });
  const database = new DatabaseSync(serviceDatabase());
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.prepare("UPDATE community_servers SET owner_id = ? WHERE id = ?").run(ownerId, created.id);
  } finally {
    database.close();
  }
  await api(token, "PUT", `/v1/community/servers/${created.id}`, {
    name,
    description:
      `Duels every evening on ${name}, a bracket every Saturday and a free for all after midnight. ` +
      "Newcomers get a mentor for their first week.",
    website: "https://server.example.com/community/kyber-duel-hall",
    discord: "",
    rules: "Bow before a duel. No kicks while the other player bows. No spamming the chat. Respect the admins.",
    recommendations: [
      { title: "Kyber Crystal Hilts, the complete collection for tournament play", jkhubId: 5001 },
      { title: "Kyber Temple Duel", jkhubId: 5002 },
    ],
    revision: created.revision,
  });
  return created.id;
}

// ---------------------------------------------------------------------------
// The browser: signing in, the screens, measuring.
// ---------------------------------------------------------------------------

/** Signs in with the developer provider from `/signin`, in the language on screen. */
async function signInAs(page: Page, name: string, developer: string): Promise<void> {
  await page.getByRole("button", { name: developer }).click();
  await page.waitForURL(`${SERVICE}/v1/auth/dev/start**`);
  await page.locator("#name").fill(name);
  await page.locator("button[type=submit]").click();
  await backFromService(page);
  await page.waitForURL((url) => url.origin === BASE && !url.pathname.startsWith("/signin"), { timeout: 30_000 });
}

/** Waits until fonts, finite animations and two frames have settled. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const finite = document.getAnimations().filter((animation) => {
      const end = animation.effect?.getComputedTiming().endTime;
      return animation.playState === "running" && typeof end === "number" && Number.isFinite(end);
    });
    await Promise.race([
      Promise.all(finite.map((animation) => animation.finished.catch(() => undefined))),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

interface Screen {
  name: string;
  path: string;
  /** What shows once the screen has drawn its data; at a phone width and at a wide one. */
  ready: (page: Page, wide: boolean) => Locator;
  /** Widths to measure; all four when left out. */
  widths?: number[];
  /** Brings the screen into the state to measure after it loads, such as a drawer opened. */
  prepare?: (page: Page) => Promise<void>;
  /** Measures only inside this, such as the dialog `prepare` opens. */
  scope?: string;
  /** Undoes `prepare` before the next width. */
  undo?: (page: Page) => Promise<void>;
  /** Elements where cut text and a cut placeholder fail the test, besides `GATED_EVERYWHERE`. */
  gates?: string[];
  /** One more thing the screen must hold to, measured after the detector: what is wrong, or `null`. */
  check?: (page: Page) => Promise<string | null>;
}

/** The buttons of the open dialog stay inside its card: two that do not fit side by side go on two rows. */
async function dialogButtonsInside(page: Page): Promise<string | null> {
  const outside = await page
    .getByTestId("dialog-actions")
    .last()
    .evaluate((row) => {
      const card = (row.parentElement ?? row).getBoundingClientRect();
      return Array.from(row.querySelectorAll("button"))
        .filter((button) => {
          const box = button.getBoundingClientRect();
          return box.left < Math.max(card.left, 0) - 0.5 || box.right > Math.min(card.right, window.innerWidth) + 0.5;
        })
        .map((button) => button.textContent ?? "");
    });
  return outside.length === 0 ? null : `dialog buttons out of the card: ${outside.join(", ")}`;
}

/** The toast of the invitation to the host's group. */
function invitationToast(page: Page): Locator {
  return page.getByRole("status").filter({ hasText: INVITED_GROUP_TITLE });
}

/** Gated on every screen: the phone's title, the wide screen's rail and the buttons of a dialog. */
const GATED_EVERYWHERE = ["[data-testid=top-bar] h1", "[data-testid=rail]", "[data-testid=dialog-actions]"];

function screensOf(seeded: Seeded, language: Language): Screen[] {
  const web = webCatalog(language) as Record<string, Record<string, string>>;
  const byTest = (id: string) => (page: Page) => page.getByTestId(id);
  const byText = (text: string) => (page: Page) => page.getByText(text, { exact: false });
  const openMenu = web.nav.openMenu;
  const account = sharedCatalog(language, "account") as Record<string, Record<string, string>>;
  const chat = sharedCatalog(language, "chat") as Record<string, Record<string, string>>;
  const servers = sharedCatalog(language, "servers") as Record<string, Record<string, string>>;
  const direct = `/c/${encodeURIComponent(seeded.direct)}`;
  const info = `/c/${encodeURIComponent(seeded.group)}/info`;
  // The catalogs list what every language's test has published so far, a
  // count that depends on which test ran first: searched for this language's
  // own entry, they draw the same cards in every run. The bundles keep the
  // search in the address, the list beside a bundle's page too.
  const bundleSearch = `?q=${encodeURIComponent(seeded.bundleName)}`;
  const bundle = `/bundles/${encodeURIComponent(seeded.bundleId)}${bundleSearch}`;
  const communitySearch = async (page: Page) => {
    const box = page.getByPlaceholder(servers.community.search, { exact: true });
    if (await box.isVisible()) await box.fill(seeded.communityName);
  };
  const cards = ["[data-testid=card-actions]", "[data-testid=card-facts]"];
  return [
    {
      name: "chats",
      path: "/chats",
      ready: byTest("joinable-row"),
      // With the toast of the group invitation, which the loop then puts away.
      prepare: (page) => expect(invitationToast(page)).toBeVisible(),
      gates: ["[data-testid=joinable-row]", "[data-testid=chat-search]"],
    },
    {
      name: "drawer",
      path: "/chats",
      widths: PHONE_WIDTHS,
      ready: byTest("joinable-row"),
      scope: "[data-testid=drawer]",
      prepare: async (page) => {
        await page.getByRole("button", { name: openMenu }).click();
        await expect(page.getByTestId("drawer")).toBeVisible();
      },
      undo: async (page) => {
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("drawer")).toBeHidden();
      },
      gates: ["[data-testid=drawer-header]", "[data-testid=drawer] nav"],
    },
    {
      name: "thread-direct",
      path: direct,
      ready: byText("everyone, see you in the next round"),
      gates: cards,
      // Below the fold of the thread the detector sees no overlap: a label longer than its column would run into its value.
      check: async (page) => {
        const long = await page
          .locator("[data-testid=card-facts] dt")
          .evaluateAll((labels) => labels.filter((label) => label.scrollWidth > label.clientWidth + 1).map((label) => label.textContent ?? ""));
        return long.length === 0 ? null : `card fact labels run into their values: ${long.join(", ")}`;
      },
    },
    { name: "thread-group", path: `/c/${encodeURIComponent(seeded.group)}`, ready: byText("the ferry is at nine") },
    {
      name: "group-invite",
      path: `/c/${encodeURIComponent(seeded.invited)}`,
      ready: byTest("group-invite"),
      gates: ["[data-testid=group-invite]"],
    },
    {
      name: "group-info",
      path: info,
      ready: (page) => page.getByText(seeded.gamer.name).last(),
      gates: ["[data-testid=group-info-header]", "[data-testid=info-section-head]"],
    },
    {
      // Renaming with the field emptied: its placeholder, and what a group without a name shows.
      name: "group-info-rename",
      path: info,
      ready: (page) => page.getByText(seeded.gamer.name).last(),
      prepare: async (page) => {
        await page.getByRole("button", { name: chat.info.rename, exact: true }).click();
        await page.getByRole("textbox", { name: chat.info.renameLabel }).fill("");
      },
      undo: (page) => page.getByRole("textbox", { name: chat.info.renameLabel }).press("Escape"),
      gates: ["[data-testid=group-info-header]"],
    },
    { name: "friends", path: "/friends", ready: byTest("requests-row"), gates: ["[data-testid=requests-row]"] },
    {
      name: "friend-details",
      path: `/friends/${encodeURIComponent(seeded.host.userId)}`,
      ready: byTest("hosted-server"),
      gates: ["[data-testid=friend-name]", "[data-testid=hosted-server]"],
    },
    {
      name: "requests",
      path: "/friends/requests",
      ready: byTest("server-invite"),
      // Who asks and who was asked stay readable, the longest name whole.
      gates: ["[data-testid=request-row]", "[data-testid=server-invite]"],
    },
    { name: "settings", path: "/settings", widths: PHONE_WIDTHS, ready: (page) => page.locator('a[href="/settings/about"]') },
    {
      name: "account",
      path: "/settings/account",
      ready: byTest("account-name"),
      gates: ["[data-testid=account-identity]", "[data-testid=danger-zone]"],
    },
    { name: "notifications", path: "/settings/notifications", ready: byTest("notifications-screen"), gates: ["[data-testid=notifications-screen]"] },
    { name: "privacy", path: "/settings/privacy", ready: byTest("privacy-screen") },
    {
      name: "sessions",
      path: "/settings/sessions",
      ready: byTest("sign-out-others"),
      gates: ["[data-testid=session-row]", "[data-testid=sign-out-others]"],
    },
    { name: "install", path: "/settings/install", ready: byTest("install-screen") },
    { name: "about", path: "/settings/about", ready: byTest("build") },
    { name: "servers", path: "/servers?game=ja", ready: byTest("server-row") },
    {
      name: "server-details",
      path: `/servers/ja/${encodeURIComponent(seeded.duelAddress)}`,
      ready: byTest("server-facts"),
      gates: ["[data-testid=server-details] h1", "[data-testid=server-facts]"],
      // The fakes' names and facts are short: what a long one would do is read from the styles.
      check: async (page) => {
        const cut = await page
          .locator("[data-testid=server-details] h1 > span, [data-testid=server-facts] dd")
          .evaluateAll((items) =>
            items.filter((item) => getComputedStyle(item).whiteSpace === "nowrap" || getComputedStyle(item).textOverflow === "ellipsis").length,
          );
        return cut === 0 ? null : `${cut} of the server's name and facts would cut a long value`;
      },
    },
    { name: "jkhub", path: "/jkhub?game=ja", ready: byText("Kyber Crystal Hilts") },
    { name: "jkhub-details", path: "/jkhub/ja/5001", ready: byTest("jkhub-facts") },
    { name: "bundles", path: `/bundles${bundleSearch}`, ready: byText(seeded.bundleName) },
    {
      name: "bundle-details",
      path: bundle,
      ready: byTest("bundle-details"),
      gates: ["[data-testid=bundle-header]", "[data-testid=manifest-file]", "[data-testid=version-row]"],
    },
    { name: "community", path: "/community", ready: byText(seeded.communityName), prepare: communitySearch },
    {
      name: "community-details",
      path: `/community/${encodeURIComponent(seeded.communityId)}`,
      ready: byTest("community-details"),
      // The list beside the page on the wide screen.
      prepare: communitySearch,
      gates: [".community-files li"],
    },
    // The emoji picker: a sheet on the phone.
    {
      name: "emoji",
      path: direct,
      widths: PHONE_WIDTHS,
      ready: byText("everyone, see you in the next round"),
      scope: "[role=dialog]",
      prepare: async (page) => {
        await page.getByRole("button", { name: chat.composer.emoji, exact: true }).click();
        // The picker itself, not the note that stands in while it loads.
        await expect(page.getByRole("dialog", { name: chat.emoji.title }).getByRole("textbox")).toBeVisible();
      },
      undo: closeDialog,
      // The sheet itself, which the detector measures only inside of.
      check: async (page) => {
        const sideways = await page.getByRole("dialog", { name: chat.emoji.title }).evaluate((sheet) => sheet.scrollWidth - sheet.clientWidth);
        return sideways <= 1 ? null : `the emoji sheet scrolls sideways by ${sideways} px`;
      },
    },
    // The picture viewer over the thread.
    {
      name: "lightbox",
      path: direct,
      ready: (page) => page.locator(`button[title="${PICTURE}"]`),
      scope: "[role=dialog]",
      prepare: async (page) => {
        await page.locator(`button[title="${PICTURE}"]`).click();
        await expect(page.getByTestId("lightbox-header")).toBeVisible();
      },
      undo: closeDialog,
      gates: ["[data-testid=lightbox-header]"],
    },
    // Dialogs: a sheet on the phone, a centred panel on the wide screen.
    {
      name: "dialog-new-group",
      path: "/chats",
      ready: byTest("joinable-row"),
      scope: "[role=dialog]",
      prepare: openDialog(chat.group.new),
      undo: closeDialog,
      gates: ["[data-testid=group-name-field]"],
      check: dialogButtonsInside,
    },
    {
      name: "dialog-share",
      path: bundle,
      ready: byTest("bundle-details"),
      scope: "[role=dialog]",
      prepare: openDialog(chat.share.action),
      undo: closeDialog,
      check: dialogButtonsInside,
    },
    {
      name: "dialog-delete-account",
      path: "/settings/account",
      ready: byTest("account-name"),
      scope: "[role=dialog]",
      prepare: openDialog(account.danger.delete),
      undo: closeDialog,
      check: dialogButtonsInside,
    },
    {
      name: "dialog-sign-out-others",
      path: "/settings/sessions",
      ready: byTest("sign-out-others"),
      scope: "[role=dialog]",
      prepare: openDialog(account.devices.signOutOthers),
      undo: closeDialog,
      check: dialogButtonsInside,
    },
  ];
}

/** A tap of one finger at a point of the page, as a touch screen sends it. */
async function tapAt(page: Page, x: number, y: number): Promise<void> {
  const touch = await page.context().newCDPSession(page);
  try {
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await touch.detach();
  }
}

/** The tools of the tapped message, floating over the thread. */
function floatingTools(page: Page): Locator {
  return page.locator("[data-floating-tools]");
}

/**
 * Taps the message that starts with `start` and waits for its tools. First
 * it scrolls the message to the middle of the thread, or, given `at`, its
 * top that many px below the top of the thread (above it when negative).
 * The finger lands where a reader's would: on the first of its words or
 * cards on screen, off every link and button.
 */
async function tapMessage(page: Page, start: string, at: number | null = null): Promise<void> {
  const text = page.locator("[data-seq]").getByText(start, { exact: false }).first();
  await text.evaluate(async (node, at) => {
    const row = node.closest("[data-seq]");
    const pane = node.closest("[role=log]");
    if (row === null || pane === null) return;
    if (at === null) row.scrollIntoView({ block: "center" });
    else pane.scrollTop += row.getBoundingClientRect().top - pane.getBoundingClientRect().top - at;
    // The thread may still load or stick to its end: wait until it stays put.
    let last = -1;
    for (let same = 0, frame = 0; same < 8 && frame < 180; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      same = pane.scrollTop === last ? same + 1 : 0;
      last = pane.scrollTop;
    }
  }, at);
  await settle(page);
  const point = await text.evaluate((node) => {
    const row = node.closest("[data-seq]");
    const pane = node.closest("[role=log]");
    if (row === null || pane === null) return null;
    const frame = pane.getBoundingClientRect();
    const range = document.createRange();
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let word = walker.nextNode(); word !== null; word = walker.nextNode()) {
      const first = (word.textContent ?? "").search(/\S/);
      if (first < 0) continue;
      range.setStart(word, first);
      range.setEnd(word, first + 1);
      const letter = range.getClientRects()[0];
      if (letter === undefined || letter.width < 1 || letter.top < frame.top + 1 || letter.bottom > frame.bottom - 8) continue;
      const x = letter.left + letter.width / 2;
      const y = letter.top + letter.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit === null || !row.contains(hit)) continue;
      if (hit.closest("a, button, [role=link], [role=button]") !== null || getComputedStyle(hit).cursor === "pointer") continue;
      return { x, y };
    }
    return null;
  });
  if (point === null) throw new Error(`the message "${start}" shows nothing to tap`);
  await tapAt(page, point.x, point.y);
  await expect(floatingTools(page)).toBeVisible({ timeout: 5_000 });
}

/**
 * Puts the tools away as a player would, with a tap on the composer, and
 * takes the focus back off it; `null`, or what stayed on screen.
 */
async function dismissTools(page: Page): Promise<string | null> {
  const box = await page.locator("textarea").last().boundingBox();
  if (box !== null) await tapAt(page, box.x + box.width / 2, box.y + box.height / 2);
  const gone = await expect(floatingTools(page))
    .toHaveCount(0, { timeout: 5_000 })
    .then(
      () => null,
      () => "the message tools stay after a tap elsewhere",
    );
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(floatingTools(page)).toHaveCount(0);
  return gone;
}

/**
 * The tools of the tapped message lie inside the thread, draw over none of
 * its text nor over the sender's name above it, and each of them takes a
 * tap: no box around them cuts them off or covers them. A message `tall`er
 * than the thread leaves no room around it: there the tools float over its
 * part on screen, still off its text.
 */
async function toolsClear(page: Page, tall = false): Promise<string | null> {
  return floatingTools(page).evaluate((tools, tall) => {
    const row = tools.closest("[data-seq]");
    const pane = tools.closest("[role=log]");
    if (row === null || pane === null) return "the message tools are outside their message";
    const strip = tools.getBoundingClientRect();
    const frame = pane.getBoundingClientRect();
    if (tall && row.getBoundingClientRect().height <= frame.height) return "the tall message fits the thread: nothing measured";
    const off = (edge: number, limit: number) => edge - limit > 0.5;
    if (off(frame.top, strip.top) || off(strip.bottom, frame.bottom) || off(frame.left, strip.left) || off(strip.right, frame.right)) {
      return `the message tools lie outside the thread: ${Math.round(strip.top)}..${Math.round(strip.bottom)} of ${Math.round(frame.top)}..${Math.round(frame.bottom)}`;
    }
    // The sender's name over the first message of a run in a group.
    const head = row.previousElementSibling;
    const own = [row, head?.hasAttribute("data-seq") === false ? head : null];
    const range = document.createRange();
    const covered: string[] = [];
    for (const part of own) {
      if (part === null) continue;
      const walker = document.createTreeWalker(part, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (tools.contains(node) || (node.textContent ?? "").trim() === "") continue;
        // Only the part of a line its clipping ancestors leave visible counts:
        // the lines a clamp hides are not text the tools can cover.
        const clips: DOMRect[] = [];
        for (let element = node.parentElement; element !== null && element !== pane; element = element.parentElement) {
          const style = getComputedStyle(element);
          if (style.overflowX !== "visible" || style.overflowY !== "visible") clips.push(element.getBoundingClientRect());
        }
        range.selectNodeContents(node);
        const under = Array.from(range.getClientRects()).some((line) => {
          let { left, right, top, bottom } = line;
          for (const clip of clips) {
            left = Math.max(left, clip.left);
            right = Math.min(right, clip.right);
            top = Math.max(top, clip.top);
            bottom = Math.min(bottom, clip.bottom);
          }
          return (
            right - left > 0.5 &&
            bottom - top > 0.5 &&
            Math.min(right, strip.right) - Math.max(left, strip.left) > 0 &&
            Math.min(bottom, strip.bottom) - Math.max(top, strip.top) > 0
          );
        });
        if (under) covered.push((node.textContent ?? "").trim().slice(0, 40));
      }
    }
    if (covered.length > 0) return `the message tools cover the text of their message: ${covered.join(" | ")}`;
    const buttons = Array.from(tools.querySelectorAll("button"));
    const unreachable = buttons.filter((button) => {
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit === null || !button.contains(hit);
    });
    if (buttons.length === 0 || unreachable.length > 0) {
      return `${unreachable.length} of ${buttons.length} message tools cannot be tapped: ${unreachable.map((button) => button.getAttribute("aria-label")).join(", ")}`;
    }
    return null;
  }, tall);
}

/** The start of the long message of the host, of the player's reply to it and of the host's card message. */
const LONG_MESSAGE_START = "Tonight we run the clan tournament";
const REPLY_START = "Yes. I am bringing the new hilts";
const CARDS_START = "Everything for tonight:";
/** How far the card message, taller than the thread on a phone, is scrolled past the top of the thread. */
const CARDS_CUT = 150;
/** How much further a reader scrolls through the card message with its tools shown. */
const CARDS_READ_ON = 300;
/**
 * Where the top of the host's long message in the group sits under the top
 * of the thread: with room above it for the tools and the name over it, then
 * with room for the tools alone, where the name would be under them. A short
 * thread may not scroll that far: then the message sits lower.
 */
const NAMED_AT = [120, 60] as const;

/**
 * The chats and the threads on a touch screen, where a tab is 44 px tall
 * and the tools of a message show on a tap: hidden, they take no room from
 * the bubbles and the cards; shown, they cover none of the tapped message's
 * text — above the host's long message, below it at the top of the thread,
 * above the player's own reply, clear of the host's name in the group — lie
 * inside the thread, take a tap, and go on a tap elsewhere. The card
 * message is taller than the thread: tapped with its top at the top of the
 * thread and with its top scrolled away, its tools float over its part on
 * screen, off its text, and follow it there when it is tapped again further
 * on.
 */
function touchScreensOf(seeded: Seeded): Screen[] {
  const toolsTakeNoRoom = async (page: Page) => {
    const laidOut = await page
      .getByTestId("message-tools")
      .evaluateAll((tools) => tools.filter((tool) => tool.getBoundingClientRect().width > 0).length);
    return laidOut === 0 ? null : `${laidOut} message tool strips take room before a tap`;
  };
  const noting = () => {
    const wrong: string[] = [];
    const note = (what: string, found: string | null) => {
      if (found !== null) wrong.push(`${what}: ${found}`);
    };
    return { note, found: () => (wrong.length === 0 ? null : wrong.join("; ")) };
  };
  const tappedTools = async (page: Page) => {
    const { note, found } = noting();
    note("above the long message", await toolsClear(page));
    note("a tap away from the long message", await dismissTools(page));
    await tapMessage(page, LONG_MESSAGE_START, 0);
    note("below the long message at the top of the thread", await toolsClear(page));
    note("a tap away from the long message at the top", await dismissTools(page));
    await tapMessage(page, REPLY_START);
    note("above the player's reply", await toolsClear(page));
    note("a tap away from the player's reply", await dismissTools(page));
    await tapMessage(page, CARDS_START, 0);
    note("over the card message at the top of the thread", await toolsClear(page, true));
    note("a tap away from the card message at the top", await dismissTools(page));
    await tapMessage(page, CARDS_START, -CARDS_CUT);
    note(`over the card message ${CARDS_CUT} px past the top of the thread`, await toolsClear(page, true));
    // Read on with the tools shown, then tapped again: they come along.
    await tapMessage(page, CARDS_START, -CARDS_CUT - CARDS_READ_ON);
    note(`over the card message tapped again ${CARDS_READ_ON} px further on`, await toolsClear(page, true));
    return found();
  };
  const tappedNamed = async (page: Page) => {
    const { note, found } = noting();
    note(`the host's long message ${NAMED_AT[0]} px under the top of the thread`, await toolsClear(page));
    note("a tap away from the host's long message", await dismissTools(page));
    await tapMessage(page, LONG_MESSAGE_START, NAMED_AT[1]);
    note(`the host's long message ${NAMED_AT[1]} px under the top of the thread`, await toolsClear(page));
    return found();
  };
  const dismissed = async (page: Page) => {
    await dismissTools(page);
  };
  return [
    {
      name: "chats-touch",
      path: "/chats",
      ready: (page) => page.getByTestId("joinable-row"),
      gates: ["[role=tablist]", "[data-testid=joinable-row]"],
    },
    {
      name: "thread-direct-touch",
      path: `/c/${encodeURIComponent(seeded.direct)}`,
      widths: PHONE_WIDTHS,
      ready: (page) => page.getByText("everyone, see you in the next round"),
      gates: ["[data-testid=card-actions]", "[data-testid=card-facts]"],
      check: toolsTakeNoRoom,
    },
    {
      // The host's long message tapped: measured with its tools over the thread.
      name: "thread-direct-tapped",
      path: `/c/${encodeURIComponent(seeded.direct)}`,
      widths: PHONE_WIDTHS,
      ready: (page) => page.getByText("everyone, see you in the next round"),
      prepare: (page) => tapMessage(page, LONG_MESSAGE_START),
      check: tappedTools,
      undo: dismissed,
      gates: ["[data-testid=card-actions]", "[data-testid=card-facts]"],
    },
    {
      name: "thread-group-touch",
      path: `/c/${encodeURIComponent(seeded.group)}`,
      widths: PHONE_WIDTHS,
      ready: (page) => page.getByText("the ferry is at nine"),
      check: toolsTakeNoRoom,
    },
    {
      // The host's long message in the group tapped, the first under the host's name.
      name: "thread-group-tapped",
      path: `/c/${encodeURIComponent(seeded.group)}`,
      widths: PHONE_WIDTHS,
      ready: (page) => page.getByText("the ferry is at nine"),
      prepare: (page) => tapMessage(page, LONG_MESSAGE_START, NAMED_AT[0]),
      check: tappedNamed,
      undo: dismissed,
    },
  ];
}

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

/** Text closer than this to an edge of its box a reader sees touches it: the sign-in buttons before dc73949 had 0 px. */
const TOUCHING = 1;

/**
 * A hit that fails wherever it is: text past the border of its box, against
 * an edge of it a reader sees, or in a box too short for it, anything out of
 * its card or the screen, an overlap, a word a line. Cut text is left to
 * `cutInGates`.
 */
function failsAnywhere(hit: TextFitHit): boolean {
  if (hit.kind === "clipped") return false;
  if (hit.kind === "cramped") {
    // `sides` names the visible edges the text comes closer to than the room asks.
    const touching = String(hit.detail.sides)
      .split(",")
      .some((side) => side in hit.detail && Number(hit.detail[side]) < TOUCHING);
    return touching || hit.detail.escapes === true || hit.detail.contentOverflows === true;
  }
  return true;
}

/**
 * Cut text inside the gated elements, run in the page: a clipping element
 * that is or is inside a gate, or one around a gate that cuts the gate's own
 * text (a card that hides what sticks out of its buttons), and an empty
 * field in a gate whose placeholder is wider than the field.
 */
function cutInGates({ clipped, gates }: { clipped: Array<{ path: string; text: string }>; gates: string[] }): string[] {
  const found: string[] = [];
  const range = document.createRange();
  const cutsText = (box: Element, inner: Element): boolean => {
    const style = getComputedStyle(box);
    const cutX = /hidden|clip/.test(style.overflowX);
    const cutY = /hidden|clip/.test(style.overflowY);
    const rect = box.getBoundingClientRect();
    const left = rect.left + box.clientLeft;
    const top = rect.top + box.clientTop;
    const walker = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      // Text a pane in between scrolls away is not cut.
      let scrolled = false;
      for (let up = node.parentElement; up !== null && up !== box; up = up.parentElement) {
        const own = getComputedStyle(up);
        scrolled ||= /auto|scroll/.test(own.overflowX) || /auto|scroll/.test(own.overflowY);
      }
      if (scrolled) continue;
      range.selectNodeContents(node);
      for (const line of Array.from(range.getClientRects())) {
        if (line.width < 0.5 || line.height < 0.5) continue;
        if (cutX && (line.left < left - 1 || line.right > left + box.clientWidth + 1)) return true;
        if (cutY && (line.top < top - 1 || line.bottom > top + box.clientHeight + 1)) return true;
      }
    }
    return false;
  };
  for (const hit of clipped) {
    const element = document.querySelector(hit.path);
    if (element === null) continue;
    const gate = gates.find(
      (selector) =>
        element.closest(selector) !== null || Array.from(element.querySelectorAll(selector)).some((inner) => cutsText(element, inner)),
    );
    if (gate !== undefined) found.push(`cut in ${gate}: "${hit.text.slice(0, 100)}"`);
  }
  const canvas = document.createElement("canvas").getContext("2d");
  for (const gate of gates) {
    for (const scope of Array.from(document.querySelectorAll(gate))) {
      const fields = scope.matches("input[placeholder]") ? [scope] : Array.from(scope.querySelectorAll("input[placeholder]"));
      for (const field of fields as HTMLInputElement[]) {
        if (canvas === null || field.value !== "" || field.placeholder === "" || field.getClientRects().length === 0) continue;
        const style = getComputedStyle(field);
        canvas.font = style.font;
        canvas.letterSpacing = style.letterSpacing === "normal" ? "0px" : style.letterSpacing;
        const needed = canvas.measureText(field.placeholder).width;
        const room = field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        if (needed > room + 1) found.push(`placeholder cut in ${gate}: "${field.placeholder}" needs ${Math.round(needed)} of ${Math.round(room)} px`);
      }
    }
  }
  return found;
}

/** What of a measurement fails the gate: the hits that fail anywhere, and what `cutInGates` finds in `gates`. */
async function gateFailures(page: Page, hits: TextFitHit[], gates: string[]): Promise<string[]> {
  const failures = hits
    .filter(failsAnywhere)
    .map((hit) => `${hit.kind} ${hit.component} "${hit.text.slice(0, 100)}" ${JSON.stringify(hit.detail).slice(0, 240)}`);
  const clipped = hits.filter((hit) => hit.kind === "clipped").map((hit) => ({ path: hit.path, text: hit.text }));
  failures.push(...(await page.evaluate(cutInGates, { clipped, gates })));
  return failures;
}

/** Collects hits and crops for one language. */
class Report {
  readonly hits: HitRecord[] = [];
  readonly coverage: Coverage[] = [];
  readonly notes: string[] = [];
  /** What fails the test: `<width>px <screen>: <what>`. */
  readonly failures: string[] = [];
  private readonly shot = new Set<string>();

  constructor(readonly language: Language) {
    mkdirSync(join(OUT, "hits"), { recursive: true });
    for (const folder of ["shots", "screens"]) {
      mkdirSync(join(OUT, folder), { recursive: true });
      for (const file of readdirSync(join(OUT, folder))) {
        if (file.startsWith(`${language}-`)) rmSync(join(OUT, folder, file), { force: true });
      }
    }
  }

  /** Measures the page as it is, records what it finds and what of it fails the gate. */
  async measure(
    page: Page,
    screen: string,
    path: string,
    width: number,
    status: string,
    scope?: string,
    gates: string[] = [],
  ): Promise<HitRecord[]> {
    await settle(page);
    const found = await page.evaluate(detectTextFit, { ...ROOM, scope });
    const route = new URL(page.url()).pathname + new URL(page.url()).search;
    const records = found.map((hit): HitRecord => ({ ...hit, language: this.language, width, screen, route }));
    // A ready marker squeezed to nothing is a text that no longer fits.
    if (status.startsWith("not visible")) this.fail(width, screen, status);
    for (const failure of await gateFailures(page, found, [...GATED_EVERYWHERE, ...gates])) this.fail(width, screen, failure);
    if (SCREENS) {
      await page.screenshot({ path: join(OUT, "screens", `${this.language}-${width}-${screen}.png`), animations: "disabled" });
    }
    for (const record of records) {
      const layout = width >= 768 ? "wide" : "phone";
      const id = `${record.kind}|${record.key}|${layout}`;
      if (this.shot.has(id) || this.shot.size >= SHOTS_PER_LANGUAGE) continue;
      this.shot.add(id);
      record.shot = await crop(page, record, `${this.language}-${width}-${screen}-${record.kind}-${digest(id)}.png`);
    }
    this.hits.push(...records);
    this.coverage.push({ screen, path, width, status, hits: records.length });
    return records;
  }

  /** Something that fails the test, written with the hits too. */
  fail(width: number, screen: string, what: string): void {
    this.failures.push(`${width}px ${screen}: ${what}`);
  }

  /** A line about the run, kept with the hits. */
  note(text: string): void {
    this.notes.push(text);
  }

  /** Writes this language's hits and merges every language's into `rendered-hits.json`. */
  write(): void {
    writeFileSync(
      join(OUT, "hits", `${this.language}.json`),
      JSON.stringify(
        {
          language: this.language,
          finishedAt: new Date().toISOString(),
          notes: this.notes,
          failures: this.failures,
          coverage: this.coverage,
          hits: this.hits,
        },
        null,
        1,
      ),
    );
    withLock(join(OUT, ".merge-lock"), () => {
      const merged: {
        generatedAt: string;
        room: TextFitOptions;
        widths: number[];
        notes: Record<string, string[]>;
        coverage: Record<string, Coverage[]>;
        hits: HitRecord[];
      } = { generatedAt: new Date().toISOString(), room: ROOM, widths: WIDTHS, notes: {}, coverage: {}, hits: [] };
      for (const file of readdirSync(join(OUT, "hits")).filter((name) => name.endsWith(".json")).sort()) {
        const part = JSON.parse(readFileSync(join(OUT, "hits", file), "utf8")) as {
          language: string;
          notes?: string[];
          coverage: Coverage[];
          hits: HitRecord[];
        };
        merged.notes[part.language] = part.notes ?? [];
        merged.coverage[part.language] = part.coverage;
        merged.hits.push(...part.hits);
      }
      const temporary = join(OUT, `rendered-hits.${process.pid}.tmp`);
      writeFileSync(temporary, JSON.stringify(merged, null, 1));
      renameSync(temporary, join(OUT, "rendered-hits.json"));
    });
  }
}

function digest(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 10);
}

/**
 * A crop around the element of a hit, outlined, saved under `shots/`. The
 * element is scrolled into view for the crop, and every scroll position is
 * put back afterwards, so the next measurement sees the page as the app
 * left it.
 */
async function crop(page: Page, hit: HitRecord, file: string): Promise<string | undefined> {
  const box = await page.evaluate((path) => {
    const element = document.querySelector(path);
    if (element === null) return null;
    const scrolled = Array.from(document.querySelectorAll("*"))
      .filter((node) => node.scrollLeft !== 0 || node.scrollTop !== 0 || node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight)
      .map((node) => ({ node, left: node.scrollLeft, top: node.scrollTop }));
    (window as unknown as { textFitScroll?: typeof scrolled }).textFitScroll = scrolled;
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    const rect = element.getBoundingClientRect();
    const mark = document.createElement("div");
    mark.id = "text-fit-mark";
    Object.assign(mark.style, {
      position: "fixed",
      left: `${rect.left - 2}px`,
      top: `${rect.top - 2}px`,
      width: `${rect.width + 4}px`,
      height: `${rect.height + 4}px`,
      outline: "2px solid #ff00aa",
      pointerEvents: "none",
      zIndex: "2147483647",
    });
    document.body.appendChild(mark);
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }, hit.kind === "overflow" && hit.key.startsWith("page|") ? "body" : hit.path);
  const viewport = page.viewportSize() ?? { width: WIDE_WIDTH, height: WIDE_HEIGHT };
  try {
    // Enough around the element to see where it is: the phone's whole
    // width, and at least 160 px of height.
    const whole = box === null || hit.key.startsWith("page|");
    const marginX = whole ? 0 : Math.max(24, (Math.min(viewport.width, 400) - box.width) / 2);
    const marginY = whole ? 0 : Math.max(24, (160 - box.height) / 2);
    const left = whole ? 0 : Math.max(0, Math.floor(box.x - marginX));
    const top = whole ? 0 : Math.max(0, Math.floor(box.y - marginY));
    const right = whole ? viewport.width : Math.min(viewport.width, Math.ceil(box.x + box.width + marginX));
    const bottom = whole ? viewport.height : Math.min(viewport.height, Math.ceil(box.y + box.height + marginY));
    if (right - left < 4 || bottom - top < 4) return undefined;
    const path = join(OUT, "shots", file);
    await page.screenshot({ path, clip: { x: left, y: top, width: right - left, height: bottom - top }, animations: "disabled" });
    return path;
  } finally {
    await page.evaluate(() => {
      document.getElementById("text-fit-mark")?.remove();
      const saved = (window as unknown as { textFitScroll?: Array<{ node: Element; left: number; top: number }> }).textFitScroll ?? [];
      for (const entry of saved) {
        entry.node.scrollLeft = entry.left;
        entry.node.scrollTop = entry.top;
      }
    });
  }
}

/** Runs `work` while holding a lock folder; takes over a lock older than a minute. */
function withLock(lock: string, work: () => void): void {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 60_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        // Released meanwhile.
      }
      if (Date.now() > deadline) throw new Error(`could not take ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function sizeFor(width: number): { width: number; height: number } {
  return { width, height: width >= 768 ? WIDE_HEIGHT : PHONE_HEIGHT };
}

/**
 * Goes to a path inside the running app, as a link would: a history entry
 * and the router's `popstate`. A page load per screen would boot the app
 * two dozen times a minute and run into the service's 60 requests a minute
 * per token; the app's own navigation asks for what the screen needs only.
 */
async function navigate(page: Page, path: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({ usr: null, key: Math.random().toString(36).slice(2, 10), idx: 0 }, "", target);
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  }, path);
}

/** Opens a screen and measures it at each of its widths. */
async function measureScreen(page: Page, report: Report, screen: Screen): Promise<void> {
  const widths = screen.widths ?? WIDTHS;
  await page.setViewportSize(sizeFor(widths[0]));
  await navigate(page, screen.path);
  for (const width of widths) {
    const wide = width >= 768;
    await page.setViewportSize(sizeFor(width));
    await expect(page.locator(`[data-layout=${wide ? "wide" : "phone"}]`).first()).toBeVisible();
    // In the DOM first, then on screen: an element squeezed to nothing is a
    // finding of its own, not a reason to wait.
    const marker = screen.ready(page, wide).first();
    let ready = await marker.waitFor({ state: "attached", timeout: screen.name === "servers" ? 30_000 : 15_000 }).then(
      () => "ok",
      () => "not ready: measured without its data",
    );
    if (ready === "ok" && !(await marker.isVisible())) ready = "not visible: its ready marker is in the page but not on screen";
    if (ready !== "ok") {
      await page.screenshot({ path: join(OUT, "shots", `${report.language}-${width}-${screen.name}-not-ready.png`), animations: "disabled" });
    }
    if (screen.prepare !== undefined) {
      const failed = await screen.prepare(page).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0],
      );
      if (failed !== null) {
        report.coverage.push({ screen: screen.name, path: screen.path, width, status: `not measured: ${failed}`, hits: 0 });
        // A screen that could not be opened is not a pass.
        report.fail(width, screen.name, `not measured: ${failed}`);
        continue;
      }
    }
    await report.measure(page, screen.name, screen.path, width, ready, screen.scope, screen.gates);
    const wrong = screen.check === undefined ? null : await screen.check(page);
    if (wrong !== null) report.fail(width, screen.name, wrong);
    const rail = wide ? await railTilesEven(page) : null;
    if (rail !== null) report.fail(width, screen.name, rail);
    if (screen.undo !== undefined) await screen.undo(page);
  }
}

/** The least room between a rail label and the sides of its tile. */
const RAIL_LABEL_ROOM = 4;

/**
 * The wide screen's rail: every tile as wide as the others and inside the
 * rail, every label at least `RAIL_LABEL_ROOM` px off the sides of its tile.
 * A long label wraps rather than widening its tile. `null` without a rail.
 */
async function railTilesEven(page: Page): Promise<string | null> {
  return page.evaluate((room) => {
    const rail = document.querySelector("[data-testid=rail]");
    if (rail === null) return null;
    const edge = rail.getBoundingClientRect();
    const tiles = Array.from(rail.querySelectorAll("a[data-section]"));
    const widths = tiles.map((tile) => Math.round(tile.getBoundingClientRect().width * 10) / 10);
    const wrong: string[] = [];
    if (Math.max(...widths) - Math.min(...widths) > 0.5) wrong.push(`rail tiles of different widths: ${widths.join(", ")}`);
    const range = document.createRange();
    for (const tile of tiles) {
      const box = tile.getBoundingClientRect();
      const label = tile.querySelector("[data-testid=rail-label]");
      if (box.left < edge.left - 0.5 || box.right > edge.right + 0.5) wrong.push(`rail tile out of the rail: ${label?.textContent ?? ""}`);
      if (label === null) continue;
      range.selectNodeContents(label);
      const lines = Array.from(range.getClientRects()).filter((line) => line.width > 0.5);
      const left = Math.min(...lines.map((line) => line.left)) - box.left;
      const right = box.right - Math.max(...lines.map((line) => line.right));
      if (Math.min(left, right) < room - 0.05) {
        wrong.push(`rail label ${Math.round(Math.min(left, right) * 10) / 10} px off its tile: ${label.textContent ?? ""}`);
      }
    }
    return wrong.length === 0 ? null : wrong.join("; ");
  }, RAIL_LABEL_ROOM);
}

/** Opens a dialog with a button of the screen, by its name. */
function openDialog(name: string): (page: Page) => Promise<void> {
  return async (page) => {
    const button = page.getByRole("button", { name, exact: true }).first();
    await button.click({ timeout: 5_000 }).catch(() => button.dispatchEvent("click"));
    await expect(page.getByRole("dialog").last()).toBeVisible({ timeout: 5_000 });
  };
}

/** Closes the dialog on screen: Escape, or the system back for a sheet that keeps it. */
async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  const dialogs = page.getByRole("dialog");
  if (await dialogs.count().then((count) => count > 0)) {
    await expect(dialogs).toHaveCount(0, { timeout: 2_000 }).catch(async () => {
      await page.goBack();
      await expect(dialogs).toHaveCount(0);
    });
  }
}

for (const language of LANGUAGES) {
  test.describe(`text fit, ${language}`, () => {
    // The times on screen are the service's, stamped as the seed goes, and
    // change from run to run; the zone they show in is pinned, so another
    // machine draws the same hours. They move no hit: the time of a message
    // and of a chat's last message is set in the mono face and two-digit
    // hours, as wide at any hour, and every other date, time and age — a
    // picture's or an invitation's time, a bundle's day, "Last active 2
    // minutes ago" — sits in a line that wraps rather than one that cuts it.
    test.use({ locale: LOCALES[language], timezoneId: "UTC", viewport: sizeFor(PHONE_WIDTHS[0]) });

    test(`every screen in ${language} at ${WIDTHS.join(", ")} px`, async ({ page, guard }) => {
      test.setTimeout(240_000);
      const account = sharedCatalog(language, "account") as Record<string, Record<string, string>>;
      const providers = account.providers;
      const report = new Report(language);
      let seeded: Seeded | null = null;
      try {
        // -- Signed out: a sign-in finished elsewhere, the card, its error ---
        await ownAddress(page.context());
        await page.goto("/signin/done");
        await expect(page.getByTestId("signin-elsewhere")).toBeVisible();
        for (const width of WIDTHS) {
          await page.setViewportSize(sizeFor(width));
          await report.measure(page, "signin-done", "/signin/done", width, "ok", undefined, ["[data-testid=signin-elsewhere]"]);
        }
        await page.goto("/signin");
        const jkhub = page.getByRole("button", { name: providers.continueJkhub });
        await expect(jkhub).toBeVisible();
        const signInHits: HitRecord[] = [];
        for (const width of WIDTHS) {
          await page.setViewportSize(sizeFor(width));
          signInHits.push(...(await report.measure(page, "signin", "/signin", width, "ok")));
        }
        // The provider buttons grow with their note (dc73949).
        const labels = [providers.continueJkhub, providers.continueDiscord];
        const providerHits = signInHits.filter((hit) => labels.some((label) => hit.control.includes(label)));
        expect(
          providerHits.map((hit) => `${hit.width}px ${hit.kind}: ${hit.component} ${JSON.stringify(hit.detail)}`),
          "the sign-in provider buttons keep their text off the border",
        ).toEqual([]);

        // The gate is not empty: drawn as they were before dc73949 — 56 px
        // fixed, no vertical padding, the note clamped to two lines — the
        // buttons fail it wherever the note wraps at 320 px, their text
        // against the border or past it.
        await page.setViewportSize(sizeFor(PHONE_WIDTHS[0]));
        const wrapped = await page.evaluate((names) => {
          let wraps = false;
          for (const button of Array.from(document.querySelectorAll("button"))) {
            if (!names.some((name) => (button.textContent ?? "").includes(name))) continue;
            const note = button.querySelector("span > span:last-child") as HTMLElement | null;
            if (note === null) continue;
            wraps ||= note.getBoundingClientRect().height > parseFloat(getComputedStyle(note).lineHeight) * 1.5;
            Object.assign(button.style, { height: "56px", minHeight: "0", paddingTop: "0", paddingBottom: "0" });
            Object.assign(note.style, { display: "-webkit-box", webkitBoxOrient: "vertical", webkitLineClamp: "2", overflow: "hidden" });
          }
          return wraps;
        }, labels);
        await settle(page);
        const before = (await page.evaluate(detectTextFit, ROOM)).filter((hit) => labels.some((label) => hit.control.includes(label)));
        if (wrapped) expect(before.filter(failsAnywhere).length, "the gate fails the pre-dc73949 buttons").toBeGreaterThan(0);
        await page.evaluate((names) => {
          for (const button of Array.from(document.querySelectorAll("button"))) {
            if (!names.some((name) => (button.textContent ?? "").includes(name))) continue;
            button.removeAttribute("style");
            button.querySelector("span > span:last-child")?.removeAttribute("style");
          }
        }, labels);
        report.note(`pre-dc73949 provider buttons at 320 px: note wraps ${wrapped}, detector hits ${before.length}: ${before.map((hit) => `${hit.kind} ${JSON.stringify(hit.detail)}`).join(" | ")}`);

        // JKHub has no OAuth client on the e2e service: the card says so, and
        // the browser logs the service's 503.
        guard.allowed.push(/^Failed to load resource: the server responded with a status of 503/);
        await page.setViewportSize(sizeFor(PHONE_WIDTHS[0]));
        await jkhub.click();
        const failed = page.getByTestId("signin-failed");
        const failedStatus = await failed.waitFor({ state: "visible", timeout: 10_000 }).then(
          () => "ok",
          () => "not ready: no provider error shown",
        );
        for (const width of WIDTHS) {
          await page.setViewportSize(sizeFor(width));
          await report.measure(page, "signin-error", "/signin", width, failedStatus);
        }

        // -- Signed in, with everything the screens draw ---------------------
        await page.setViewportSize(sizeFor(PHONE_WIDTHS[0]));
        const myName = `Bartholomew Wolf ${letters(language, 6)}`;
        await signInAs(page, myName, providers.developer);
        seeded = await seed(page, language, myName);
        // The server list scans the fakes on its first read: ask now.
        void fetch(`${SERVICE}/v1/servers?game=ja`, { headers: { authorization: `Bearer ${seeded.me.token}` } }).catch(() => undefined);
        // One load with everything seeded; from here on the app navigates itself.
        await page.goto("/chats");
        await expect(page.locator("[data-layout]").first()).toBeVisible();

        const common = sharedCatalog(language, "common") as Record<string, Record<string, string>>;
        for (const screen of screensOf(seeded, language)) {
          await measureScreen(page, report, screen);
          // Measured with the chats, the toast would cover the bottom of every other screen.
          if (screen.name === "chats") await invitationToast(page).locator(`button[aria-label="${common.actions.dismiss}"]`).click();
        }
        // A touch screen, as a phone or a tablet reports it: `(pointer: coarse)`.
        const touch = await page.context().newCDPSession(page);
        await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        for (const screen of touchScreensOf(seeded)) {
          await measureScreen(page, report, screen);
        }
        await touch.send("Emulation.setTouchEmulationEnabled", { enabled: false });

        expect(report.failures, "text fits what the layout audit fixed").toEqual([]);
      } finally {
        seeded?.stop();
        report.write();
      }
    });
  });
}
