/**
 * Files and cards in the web app (slice W3): pictures lose what they record
 * about their taking before they leave the device, the service's 25 MiB
 * limit holds on both sides of the line, a program asks before it is saved,
 * pictures and videos show through `blob:` addresses of files fetched with
 * the token, and every card kind a PC launcher sends is drawn read-only,
 * without a single command refused as the launcher's.
 */

import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";

import type { Browser, Page } from "@playwright/test";

import { chatText, composer, makeFriends, messageRow, openDirect } from "./chat-fixtures.ts";
import { expect, launcherSignIn, SERVICE, signIn, test, uniqueName, visit, type LauncherClient } from "./fixtures.ts";

const MIB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Pictures with something to hide
// ---------------------------------------------------------------------------

/** A picture the page draws and encodes itself: a real JPEG or PNG of this engine's encoder. */
async function encoded(page: Page, type: "image/jpeg" | "image/png"): Promise<Buffer> {
  const base64 = await page.evaluate(async (mime) => {
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 32;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2D canvas");
    context.fillStyle = "#c83232";
    context.fillRect(0, 0, 48, 32);
    context.fillStyle = "#32c850";
    context.fillRect(8, 8, 24, 12);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.9));
    if (blob === null) throw new Error(`the canvas cannot encode ${mime}`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  }, type);
  return Buffer.from(base64, "base64");
}

function u16le(value: number): number[] {
  return [value & 0xff, value >> 8];
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24];
}

/** 55° 45' 12.34" N, as the rationals of an Exif GPS block store it. */
const GPS_RATIONALS = Buffer.from([55, 0, 0, 0, 1, 0, 0, 0, 45, 0, 0, 0, 1, 0, 0, 0, 0xd2, 0x04, 0, 0, 100, 0, 0, 0]);

/** An Exif block as a phone camera writes one: the orientation, and where the photo was taken. */
function exifWithGps(): Buffer {
  const gpsAt = 8 + 2 + 2 * 12 + 4;
  const rationalsAt = gpsAt + 2 + 2 * 12 + 4;
  const tiff = [
    ...Buffer.from("II*\0", "latin1"),
    ...u32le(8),
    ...u16le(2),
    ...u16le(0x0112), ...u16le(3), ...u32le(1), ...u16le(1), 0, 0,
    ...u16le(0x8825), ...u16le(4), ...u32le(1), ...u32le(gpsAt),
    ...u32le(0),
    ...u16le(2),
    ...u16le(0x0001), ...u16le(2), ...u32le(2), ...Buffer.from("N\0\0\0", "latin1"),
    ...u16le(0x0002), ...u16le(5), ...u32le(3), ...u32le(rationalsAt),
    ...u32le(0),
    ...GPS_RATIONALS,
  ];
  return Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from(tiff)]);
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const length = payload.length + 2;
  return Buffer.concat([Buffer.from([0xff, marker, length >> 8, length & 0xff]), payload]);
}

/** The JPEG with the camera's Exif (GPS included) and a comment right after its start. */
function withGps(jpeg: Buffer): Buffer {
  return Buffer.concat([
    jpeg.subarray(0, 2),
    jpegSegment(0xe1, exifWithGps()),
    jpegSegment(0xfe, Buffer.from("taken at home", "latin1")),
    jpeg.subarray(2),
  ]);
}

function pngChunk(kind: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(kind, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** The PNG with a text chunk that names a place, right after its header. */
function withText(png: Buffer): Buffer {
  const headerEnd = 8 + 25;
  return Buffer.concat([
    png.subarray(0, headerEnd),
    pngChunk("tEXt", Buffer.from("Comment\0shot at 55.75N 37.61E", "latin1")),
    png.subarray(headerEnd),
  ]);
}

/** A short silent WebM this engine records of a page: Playwright's own video capture. */
async function recordedVideo(browser: Browser, dir: string): Promise<Buffer> {
  const context = await browser.newContext({ recordVideo: { dir, size: { width: 160, height: 90 } }, viewport: { width: 160, height: 90 } });
  const page = await context.newPage();
  await page.setContent('<body style="margin:0;background:#c33"><div id="x" style="width:40px;height:40px;background:#3c3"></div></body>');
  for (let step = 0; step < 12; step += 1) {
    await page.evaluate((at) => {
      const box = document.getElementById("x");
      if (box !== null) box.style.marginLeft = `${at * 10}px`;
    }, step);
    await page.waitForTimeout(80);
  }
  const video = page.video();
  await context.close();
  if (video === null) throw new Error("no video was recorded");
  return readFileSync(await video.path());
}

// ---------------------------------------------------------------------------
// Composer and thread
// ---------------------------------------------------------------------------

/** Files as the file picker of the composer hands them over. */
async function pick(page: Page, files: Array<{ name: string; mimeType: string; buffer: Buffer }>): Promise<void> {
  await page.locator('input[type="file"]').first().setInputFiles(files);
  const tray = page.getByRole("list", { name: chatText("composer.attachments") });
  for (const file of files) await expect(tray.getByText(file.name, { exact: true })).toBeVisible({ timeout: 30_000 });
}

/**
 * A picture pasted into the composer's field, as from the clipboard. A
 * synthetic paste of Firefox carries no files, so there the picker hands
 * the picture over instead.
 */
async function paste(page: Page, browserName: string, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  if (browserName === "firefox") {
    await pick(page, [file]);
    return;
  }
  await composer(page).evaluate(
    (field, { name, mimeType, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name, { type: mimeType }));
      field.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    },
    { name: file.name, mimeType: file.mimeType, base64: file.buffer.toString("base64") },
  );
  const tray = page.getByRole("list", { name: chatText("composer.attachments") });
  await expect(tray.getByText(file.name, { exact: true })).toBeVisible({ timeout: 30_000 });
}

/** Presses **Send** and waits until the message with this file is in the thread. */
async function sendFiles(page: Page, firstName: string): Promise<void> {
  await page.getByRole("button", { name: chatText("composer.send"), exact: true }).click();
  await expect(messageRow(page, firstName)).toBeVisible({ timeout: 60_000 });
}

/** Two friends in their direct chat, both on its thread. */
async function twoFriends(page: Page, players: { open(): Promise<Page> }) {
  const kyle = uniqueName("Kyle");
  const jan = uniqueName("Jan");
  await signIn(page, kyle);
  const other = await players.open();
  await signIn(other, jan);
  await makeFriends(page, kyle, other, jan);
  const id = await openDirect(page, jan);
  await visit(other, `/c/${encodeURIComponent(id)}`);
  await expect(composer(other)).toBeVisible();
  return { kyle, jan, other, id };
}

/** Saves a picture of the thread from the lightbox and answers the saved bytes. */
async function saveFromLightbox(page: Page, name: string): Promise<Buffer> {
  const picture = page.getByRole("button", { name: chatText("files.image.open", { name }) });
  await expect(picture.locator("img")).toHaveAttribute("src", /^blob:/, { timeout: 30_000 });
  await picture.click();
  const lightbox = page.getByRole("dialog", { name });
  await expect(lightbox.locator("img")).toHaveAttribute("src", /^blob:/);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    lightbox.getByRole("button", { name: chatText("files.save"), exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(name);
  const bytes = readFileSync(await download.path());
  await lightbox.getByRole("button", { name: chatText("files.image.close") }).click();
  await expect(lightbox).toHaveCount(0);
  return bytes;
}

test("a photo loses its GPS and a PNG its text before they leave, and both open whole", async ({ page, players, browserName }) => {
  test.setTimeout(120_000);
  const { other } = await twoFriends(page, players);

  const photo = withGps(await encoded(page, "image/jpeg"));
  const picture = withText(await encoded(page, "image/png"));
  expect(photo.includes(GPS_RATIONALS)).toBe(true);
  expect(picture.includes(Buffer.from("tEXt"))).toBe(true);
  // The photo from the file picker, the picture from the clipboard.
  await pick(page, [{ name: "gps.jpg", mimeType: "image/jpeg", buffer: photo }]);
  await paste(page, browserName, { name: "note.png", mimeType: "image/png", buffer: picture });
  await sendFiles(page, "gps.jpg");
  // The sender's own copy shows without coming back down.
  await expect(page.getByRole("button", { name: chatText("files.image.open", { name: "gps.jpg" }) }).locator("img")).toHaveAttribute(
    "src",
    /^blob:/,
  );

  // Jan's copies come down through the token and show as blob: addresses.
  await expect(messageRow(other, "gps.jpg")).toBeVisible({ timeout: 30_000 });
  const savedPhoto = await saveFromLightbox(other, "gps.jpg");
  expect([...savedPhoto.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  expect(savedPhoto.includes(GPS_RATIONALS), "the GPS position is gone").toBe(false);
  expect(savedPhoto.includes(Buffer.from("II*\0", "latin1")), "the camera's Exif block is gone").toBe(false);
  expect(savedPhoto.includes(Buffer.from("taken at home")), "the comment is gone").toBe(false);
  expect(savedPhoto.length).toBeLessThan(photo.length);

  const savedPicture = await saveFromLightbox(other, "note.png");
  expect(savedPicture.subarray(0, 8)).toEqual(picture.subarray(0, 8));
  expect(savedPicture.includes(Buffer.from("tEXt")), "the text chunk is gone").toBe(false);
  expect(savedPicture.includes(Buffer.from("55.75N"))).toBe(false);
});

test("a file of 25 MiB goes, one byte more is refused before it leaves", async ({ page, players }) => {
  test.setTimeout(180_000);
  const { other } = await twoFriends(page, players);

  // Dropped on the composer, as from the desktop: the bytes are made in the page.
  const dropped = await page.evaluateHandle((mib) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(25 * mib)], "exact.bin"));
    transfer.items.add(new File([new Uint8Array(25 * mib + 1)], "big.bin"));
    return transfer;
  }, MIB);
  await composer(page).dispatchEvent("drop", { dataTransfer: dropped });

  const refused = page.getByText(chatText("composer.refusedTitle_one", { count: 1 }));
  await expect(refused).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/^big\.bin: .*a chat file is at most 25 MiB/)).toBeVisible();
  const tray = page.getByRole("list", { name: chatText("composer.attachments") });
  await expect(tray.getByText("exact.bin", { exact: true })).toBeVisible();
  await expect(tray.getByText("big.bin", { exact: true })).toHaveCount(0);

  await sendFiles(page, "exact.bin");
  const row = messageRow(other, "exact.bin");
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText("25.0 MB");
});

test("a program asks before it is saved, and saves under its name", async ({ page, players }) => {
  const { other } = await twoFriends(page, players);
  const program = Buffer.concat([Buffer.from("MZ\x90\0", "latin1"), Buffer.alloc(512, 7)]);
  await pick(page, [{ name: "tool.exe", mimeType: "application/octet-stream", buffer: program }]);
  await sendFiles(page, "tool.exe");

  const card = other.getByRole("group", { name: chatText("cards.label", { kind: chatText("files.class.executable"), title: "tool.exe" }) });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("(.exe)");
  await card.getByRole("button", { name: chatText("files.save"), exact: true }).click();

  const ask = other.getByRole("dialog", { name: chatText("safety.save.title", { name: "tool.exe" }) });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("tool.exe is a program");
  const [download] = await Promise.all([
    other.waitForEvent("download"),
    ask.getByRole("button", { name: chatText("safety.save.confirm") }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("tool.exe");
  await expect(ask).toHaveCount(0);
  await expect(card).toContainText(chatText("files.saved", { path: "tool.exe" }));
});

test("a video comes down when tapped and plays in place", async ({ page, players, browser, browserName }, testInfo) => {
  test.skip(
    browserName === "webkit",
    "Playwright's WebKit build for Windows plays neither WebM nor MP4 (MEDIA_ERR_SRC_NOT_SUPPORTED); Safari on a phone plays MP4",
  );
  test.setTimeout(120_000);
  const { other } = await twoFriends(page, players);
  const video = await recordedVideo(browser, testInfo.outputPath("video"));
  await pick(page, [{ name: "clip.webm", mimeType: "video/webm", buffer: video }]);
  await sendFiles(page, "clip.webm");

  const row = messageRow(other, "clip.webm");
  await expect(row).toBeVisible({ timeout: 30_000 });
  // Nothing comes down before the tap.
  await expect(row.locator("video")).toHaveCount(0);
  await row.getByRole("button", { name: chatText("files.video.playName", { name: "clip.webm" }) }).click();
  const player = row.locator("video");
  await expect(player).toHaveAttribute("src", /^blob:/, { timeout: 30_000 });
  await expect
    .poll(() => player.evaluate((element: HTMLVideoElement) => element.currentTime > 0 || element.ended), { timeout: 15_000 })
    .toBe(true);
});

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A client id as a launcher makes one: a ULID. */
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

/** A launcher of the account hosting a private server, as its heartbeat says. */
async function host(launcher: LauncherClient, sessionId: string): Promise<void> {
  const response = await fetch(`${SERVICE}/v1/presence`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${launcher.token}` },
    body: JSON.stringify({
      status: "online",
      hosting: { sessionId, game: "ja", map: "mp/ffa3", gametype: 0, players: 1, maxPlayers: 8, joinPolicy: "friends" },
    }),
  });
  expect(response.ok, `a hosting heartbeat (${response.status})`).toBe(true);
}

/** A message with cards from a launcher, the way JKNet on a PC sends one. */
async function launcherSends(launcher: LauncherClient, conversationId: string, body: string, cards: unknown[]): Promise<void> {
  const response = await fetch(`${SERVICE}/v1/chat/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${launcher.token}` },
    body: JSON.stringify({ clientId: ulid(), body, cards }),
  });
  expect(response.status, await response.text()).toBeLessThan(300);
}

const SESSION = "0123456789abcdef";

const CARDS_OF_THE_PC = [
  { type: "server", v: 1, fallbackText: "Server: Clan (203.0.113.7:29070)", address: "203.0.113.7:29070", name: "^1Clan ^7server", game: "ja", map: "mp/ffa3", gametype: 0 },
  { type: "hostInvite", v: 1, fallbackText: "Join my server: Clan night", sessionId: SESSION, name: "Clan night" },
  { type: "bundle", v: 1, fallbackText: "Bundle: Clan pack", bundleId: "01J9Z3M2K4V8Q6R5T7W9X1Y2Z3", slug: "clan-pack", name: "Clan pack", game: "ja" },
  { type: "jkhubMod", v: 1, fallbackText: "JKHub: Hilt pack", fileId: 4321, slug: "4321-hilt-pack", title: "Hilt pack", game: "ja" },
  { type: "map", v: 1, fallbackText: "Map: Carbon (mp/ffa3)", game: "ja", name: "mp/ffa3", title: "Carbon" },
];

const CARDS_OF_THE_GAME = [
  { type: "profile", v: 1, fallbackText: "Player profile: Kyle", nickname: "^4Kyle", model: "kyle/default", saber1: "Kyle", color1: "4" },
  { type: "bind", v: 1, fallbackText: "Bind x: say hi", binds: [{ key: "x", command: "say hi" }] },
  { type: "config", v: 1, fallbackText: "Config: clan.cfg", name: "clan.cfg", text: "seta cg_fov 100\nseta com_maxfps 125" },
];

test("every card kind a PC sends is drawn read-only, and nothing asks for the launcher", async ({ page, players }) => {
  const { jan, id } = await twoFriends(page, players);
  // Jan's launcher, on the same account: it hosts, and it sends the cards.
  const launcher = await launcherSignIn(jan);
  await host(launcher, SESSION);
  await launcherSends(launcher, id, "Cards of the PC", CARDS_OF_THE_PC);
  await launcherSends(launcher, id, "Cards of the game", CARDS_OF_THE_GAME);

  const thread = page.getByRole("log");
  await expect(messageRow(page, "Cards of the game")).toBeVisible({ timeout: 30_000 });
  const card = (kind: string, title: string) => thread.getByRole("group", { name: chatText("cards.label", { kind: chatText(`cards.kinds.${kind}`), title }) });

  const server = card("server", "203.0.113.7:29070");
  await expect(server).toBeVisible();
  await expect(server.getByRole("button", { name: chatText("cards.server.copy") })).toBeVisible();
  await expect(server).toContainText("mp/ffa3");
  await expect(server).toContainText(chatText("cards.openInLauncher"));

  const invite = card("hostInvite", "Clan night");
  await expect(invite).toBeVisible();
  await expect(invite).toContainText(chatText("cards.openInLauncher"));

  const bundle = card("bundle", "Clan pack");
  await expect(bundle).toBeVisible();
  await expect(bundle).toContainText(chatText("cards.bundle.unavailable"), { timeout: 15_000 });
  await expect(bundle.getByRole("button", { name: chatText("cards.bundle.viewOnly"), exact: true })).toBeDisabled();

  const mod = card("jkhubMod", "Hilt pack");
  await expect(mod).toBeVisible();
  await expect(mod.getByRole("button", { name: chatText("cards.jkhubMod.open") })).toBeVisible();
  await expect(mod).toContainText(chatText("cards.openInLauncher"));

  const map = card("map", "Carbon");
  await expect(map).toBeVisible();
  await expect(map).toContainText(chatText("cards.map.noPicture"));
  await expect(map.locator("img")).toHaveCount(0);
  await expect(map.getByRole("button", { name: chatText("cards.map.copy") })).toBeVisible();

  await expect(card("profile", "^4Kyle")).toContainText("kyle/default");
  await expect(card("bind", "x")).toContainText("say hi");
  await expect(card("config", "clan.cfg")).toContainText("cg_fov");

  // No control of the game anywhere in the thread: no join, no play, no
  // install, no hosting, no profile or config written.
  const gameActions = new RegExp(
    `^(${[
      chatText("cards.server.join"),
      chatText("cards.hostInvite.join"),
      chatText("cards.map.play"),
      chatText("cards.map.host"),
      chatText("cards.jkhubMod.installPlain"),
      chatText("cards.bundle.view"),
      chatText("cards.profile.save"),
      chatText("cards.bind.apply"),
      chatText("cards.config.open"),
    ]
      .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|")})`,
  );
  await expect(thread.getByRole("button", { name: gameActions })).toHaveCount(0);
  await expect(thread.getByRole("button", { name: /^Install into / })).toHaveCount(0);
});
