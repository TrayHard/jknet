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
 * threads once more on a touch screen. On each it runs
 * `text-fit-detector.ts`: text pressed against the edges of its button,
 * card, row, chip or banner; text cut off or squeezed to a word a line; a
 * box sticking out of its card; a pane or the page scrolling sideways; text
 * drawn over text or an icon. The app is loaded once after seeding and then
 * navigates itself, as a link would.
 *
 * Every hit is written as JSON, with a marked crop of each distinct one, to
 * `JKNET_TEXT_FIT_OUT` (default `web/e2e/dist/text-fit`): `hits/<lang>.json`
 * per test and `rendered-hits.json` merged over all of them, with what was
 * measured and how in `coverage`. `JKNET_TEXT_FIT_SCREENS=1` also keeps a
 * screenshot of every screen at every width.
 *
 * The test fails on what a layout audit fixed. Anywhere, on every screen:
 * text drawn past the border of its box, a box or text sticking out of its
 * card or the screen, a pane scrolling sideways, text over text or an icon,
 * and a sentence squeezed to a word a line. Text cut off (`truncate`, a
 * clamp) is often the design, a name in a dense row, so it fails only inside
 * the elements a screen's `gates` name, the ones that once cut a sentence, a
 * label or a name with room to wrap; there an empty field's placeholder has
 * to fit as well. On the sign-in the provider buttons, where a fixed height
 * once pressed a wrapped note against the border (dc73949), keep their text
 * off the border, and the detector still catches the buttons as they were.
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

/** A client id as the apps make one: a ULID. */
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

/** Random lowercase letters, to keep the long names unique in the run. */
function letters(count: number): string {
  let text = "";
  for (let index = 0; index < count; index += 1) text += String.fromCharCode(97 + Math.floor(Math.random() * 26));
  return text;
}

/** A `jknet_session` of a private server: 16 hex characters. */
function sessionId(): string {
  let id = "";
  for (let index = 0; index < 16; index += 1) id += Math.floor(Math.random() * 16).toString(16);
  return id;
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
async function seed(page: Page, myName: string): Promise<Seeded> {
  const token = await tokenOf(page);
  const myId = await userIdOf(page);
  const hostName = `Maximilian Wolfgang ${letters(4)}`;
  const gamerName = `Wilhelmina Wojciechow ${letters(2)}`;
  const askerName = `Konstantinos Papad ${letters(5)}`;
  const askedName = `Szczepan Brzeczyszcz ${letters(3)}`;
  const [host, gamer, asker] = await Promise.all([launcherSignIn(hostName), launcherSignIn(gamerName), launcherSignIn(askerName)]);
  // The asked player, and a launcher of the player: a second device to sign out.
  await Promise.all([launcherSignIn(askedName), launcherSignIn(myName)]);

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
    sessionId: sessionId(),
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
  const bundleName = `Kyber Duel Pack Extended Tournament Edition ${letters(4)}`;
  const bundle = await publishBundle(token, bundleName);
  const communityName = `Kyber Duel Hall Community Tournament Server ${letters(4)}`;
  const communityId = await publishCommunityServer(token, myId, communityName);

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

  // The group of the three, with a long title.
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
async function publishCommunityServer(token: string, ownerId: string, name: string): Promise<string> {
  const address = `1.1.1.1:${20_000 + Math.floor(Math.random() * 40_000)}`;
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
  const direct = `/c/${encodeURIComponent(seeded.direct)}`;
  const info = `/c/${encodeURIComponent(seeded.group)}/info`;
  const bundle = `/bundles/${encodeURIComponent(seeded.bundleId)}`;
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
      // A request to the player: who asks has to be readable. The row of a
      // sent request may end the name in an ellipsis, as a dense row does.
      gates: ["[data-testid=request-row][data-side=from]", "[data-testid=server-invite]"],
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
    { name: "bundles", path: "/bundles", ready: byText(seeded.bundleName) },
    {
      name: "bundle-details",
      path: bundle,
      ready: byTest("bundle-details"),
      gates: ["[data-testid=bundle-header]", "[data-testid=manifest-file]", "[data-testid=version-row]"],
    },
    { name: "community", path: "/community", ready: byText(seeded.communityName) },
    {
      name: "community-details",
      path: `/community/${encodeURIComponent(seeded.communityId)}`,
      ready: byTest("community-details"),
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

/**
 * The chats and the threads on a touch screen, where a tab is 44 px tall
 * and the tools of a message show on a tap: hidden, they take no room from
 * the bubbles and the cards.
 */
function touchScreensOf(seeded: Seeded): Screen[] {
  const toolsTakeNoRoom = async (page: Page) => {
    const laidOut = await page
      .getByTestId("message-tools")
      .evaluateAll((tools) => tools.filter((tool) => tool.getBoundingClientRect().width > 0).length);
    return laidOut === 0 ? null : `${laidOut} message tool strips take room before a tap`;
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
      name: "thread-group-touch",
      path: `/c/${encodeURIComponent(seeded.group)}`,
      widths: PHONE_WIDTHS,
      ready: (page) => page.getByText("the ferry is at nine"),
      check: toolsTakeNoRoom,
    },
  ];
}

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

/**
 * A hit that fails wherever it is: text past the border of its box or a box
 * too short for it, anything out of its card or the screen, an overlap, a
 * word a line. Cut text is left to `cutInGates`.
 */
function failsAnywhere(hit: TextFitHit): boolean {
  if (hit.kind === "clipped") return false;
  if (hit.kind === "cramped") return hit.detail.escapes === true || hit.detail.contentOverflows === true;
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
    if (screen.undo !== undefined) await screen.undo(page);
  }
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

for (const language of Object.keys(LOCALES) as Language[]) {
  test.describe(`text fit, ${language}`, () => {
    test.use({ locale: LOCALES[language], viewport: sizeFor(PHONE_WIDTHS[0]) });

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
        // buttons fail it wherever the note wraps at 320 px.
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
        if (wrapped) expect(before.length, "the detector catches the pre-dc73949 buttons").toBeGreaterThan(0);
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
        const myName = `Bartholomew Wolf ${letters(6)}`;
        await signInAs(page, myName, providers.developer);
        seeded = await seed(page, myName);
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
