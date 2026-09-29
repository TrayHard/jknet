/**
 * Files and cards of the web core: the EXIF stripping, names and classes
 * ported from the launcher's `chat/files.rs` tests, staging, upload and
 * download against a fake service, the save's danger question, the card
 * rules of `chat/cards.rs` for the web's three kinds, and the list of
 * friends' server chats.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { crc32 } from "node:zlib";

import { EVENTS, EventBus } from "../events.ts";
import { createHttp } from "../http.ts";
import { ENGINES, neutralAnswer } from "../neutral.ts";
import { memoryStorage } from "../storage.ts";
import { buildCard, CARD, checkCard, prepareCards, serverAddress } from "./cards.ts";
import { exifOrientation, pictureSize, stripMetadata } from "./exif.ts";
import {
  classify,
  CONFIRM_DANGER,
  createChatFiles,
  dangerReasons,
  isText,
  MAX_FILE_BYTES,
  MAX_OBJECT_URLS,
  sanitizeName,
} from "./files.ts";
import { createServerChats, hostingKey, JOINABLE_EVENT, readJoinable } from "./serverChats.ts";

const API = "https://api.example.com";
const CONVERSATION = "01HDIRECT00000000000000000";
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// Pictures, as `test_support` of the launcher builds them
// ---------------------------------------------------------------------------

function bytes(...parts) {
  const list = parts.map((part) => (typeof part === "string" ? Buffer.from(part, "latin1") : Uint8Array.from(part)));
  return new Uint8Array(Buffer.concat(list));
}

function segment(marker, payload) {
  const length = payload.length + 2;
  return bytes([0xff, marker, length >> 8, length & 0xff], payload);
}

const GPS_RATIONALS = Uint8Array.from([55, 0, 0, 0, 1, 0, 0, 0, 45, 0, 0, 0, 1, 0, 0, 0, 0xd2, 0x04, 0, 0, 100, 0, 0, 0]);

function u16le(value) {
  return [value & 0xff, value >> 8];
}

function u32le(value) {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24];
}

/** A little-endian Exif block with an orientation and a GPS position: 55° 45' 12.34" N. */
function exifWithGps(orientation) {
  const gpsAt = 8 + 2 + 2 * 12 + 4;
  const rationalsAt = gpsAt + 2 + 2 * 12 + 4;
  const tiff = [
    ...Buffer.from("II*\0", "latin1"),
    ...u32le(8),
    ...u16le(2),
    ...u16le(0x0112), ...u16le(3), ...u32le(1), ...u16le(orientation), 0, 0,
    ...u16le(0x8825), ...u16le(4), ...u32le(1), ...u32le(gpsAt),
    ...u32le(0),
    ...u16le(2),
    ...u16le(0x0001), ...u16le(2), ...u32le(2), ...Buffer.from("N\0\0\0", "latin1"),
    ...u16le(0x0002), ...u16le(5), ...u32le(3), ...u32le(rationalsAt),
    ...u32le(0),
    ...GPS_RATIONALS,
  ];
  return bytes("Exif\0\0", tiff);
}

/**
 * A 16 × 8 JPEG as a camera would write it: Exif with GPS, Photoshop data,
 * a comment, and a second picture after the end. The scan is not a real
 * one — the stripping reads structure, not pixels — but it carries a
 * stuffed byte and a restart marker the way a real one does.
 */
function jpegWithGps(orientation = 6) {
  return bytes(
    [0xff, 0xd8],
    segment(0xe0, bytes("JFIF\0", [1, 1, 0, 0, 1, 0, 1, 0, 0])),
    segment(0xe1, exifWithGps(orientation)),
    segment(0xed, bytes("Photoshop 3.0\u00008BIM\x04\x04 caption: garage")),
    segment(0xfe, bytes("taken at home")),
    segment(0xdb, new Uint8Array(65)),
    segment(0xc0, [8, 0, 8, 0, 16, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]),
    [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78],
    [0xff, 0xd9],
    "\xff\xd8TRAILING-PICTURE-WITH-GPS",
  );
}

function pngChunk(kind, data) {
  const body = bytes(kind, data);
  const crc = crc32(body);
  return bytes([data.length >>> 24, (data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff], body, [
    crc >>> 24,
    (crc >> 16) & 0xff,
    (crc >> 8) & 0xff,
    crc & 0xff,
  ]);
}

function png(width, height) {
  const ihdr = [0, 0, 0, width, 0, 0, 0, height, 8, 2, 0, 0, 0];
  return bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], pngChunk("IHDR", ihdr), pngChunk("IDAT", [1, 2, 3, 4]), pngChunk("IEND", []));
}

function contains(haystack, needle) {
  return Buffer.from(haystack).includes(Buffer.from(typeof needle === "string" ? Buffer.from(needle, "latin1") : needle));
}

describe("what a picture records about its taking", () => {
  test("a JPEG loses its Exif with GPS and keeps its picture and orientation", () => {
    const original = jpegWithGps();
    assert.ok(contains(original, GPS_RATIONALS));
    const stripped = stripMetadata(original);
    assert.ok(stripped !== null);
    assert.ok(!contains(stripped, GPS_RATIONALS), "the GPS position is gone");
    assert.ok(!contains(stripped, "II*\0"), "the camera's Exif block is gone");
    assert.ok(!contains(stripped, "Photoshop"), "APP13 is gone");
    assert.ok(!contains(stripped, "taken at home"), "the comment is gone");
    assert.ok(!contains(stripped, "TRAILING"), "what followed the end is gone");
    assert.deepEqual([...stripped.slice(-2)], [0xff, 0xd9]);
    assert.ok(contains(stripped, "Exif\0\0MM\0*"), "the orientation survives as a block of its own");
    const at = Buffer.from(stripped).indexOf(Buffer.from([0xff, 0xe1]));
    const length = (stripped[at + 2] << 8) | stripped[at + 3];
    assert.equal(exifOrientation(stripped.subarray(at + 4, at + 2 + length)), 6);
    assert.ok(contains(stripped, [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]), "the scan is kept whole");
    assert.deepEqual(pictureSize(stripped), { width: 16, height: 8 });
    assert.deepEqual(pictureSize(original), { width: 16, height: 8 });
  });

  test("a JPEG without a turn keeps no Exif at all, and stripping twice changes nothing", () => {
    const stripped = stripMetadata(jpegWithGps(1));
    assert.ok(!contains(stripped, "Exif"));
    assert.deepEqual(stripMetadata(stripped), stripped);
  });

  test("a PNG loses its text and Exif chunks and is exactly the picture the encoder wrote", () => {
    const plain = png(4, 3);
    const ihdrEnd = 8 + 25;
    const marked = bytes(
      plain.subarray(0, ihdrEnd),
      pngChunk("tEXt", bytes("Comment\0shot at 55.75N 37.61E")),
      pngChunk("iTXt", bytes("XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>")),
      pngChunk("zTXt", bytes("Author\0\0x\x9c\x03\0\0\0\0\x01")),
      pngChunk("eXIf", exifWithGps(1).subarray(6)),
      plain.subarray(ihdrEnd),
      "TRAILING",
    );
    const stripped = stripMetadata(marked);
    for (const kind of ["tEXt", "iTXt", "zTXt", "eXIf", "TRAILING"]) assert.ok(!contains(stripped, kind), `${kind} survived`);
    assert.ok(!contains(stripped, GPS_RATIONALS));
    assert.deepEqual(stripped, plain);
    assert.deepEqual(pictureSize(stripped), { width: 4, height: 3 });
  });

  test("other bytes are not touched", () => {
    assert.equal(stripMetadata(bytes("GIF89a\x02\0\x02\0")), null);
    assert.equal(stripMetadata(bytes("just text")), null);
  });

  test("pictures report their size, and none beyond what the service accepts", () => {
    assert.deepEqual(pictureSize(bytes("GIF89a\x40\x01\xF0\x00rest")), { width: 320, height: 240 });
    const lossy = bytes("RIFF\0\0\0\0WEBPVP8 \0\0\0\0\0\0\0\x9d\x01\x2a", u16le(640), u16le(480));
    assert.deepEqual(pictureSize(lossy), { width: 640, height: 480 });
    const bits = (100 - 1) | ((50 - 1) << 14);
    assert.deepEqual(pictureSize(bytes("RIFF\0\0\0\0WEBPVP8L\0\0\0\0\x2f", u32le(bits))), { width: 100, height: 50 });
    const extended = bytes("RIFF\0\0\0\0WEBPVP8X\0\0\0\0\0\0\0\0", [0x7f, 0x07, 0x00], [0x37, 0x04, 0x00]);
    assert.deepEqual(pictureSize(extended), { width: 1920, height: 1080 });
    assert.equal(pictureSize(bytes("GIF89a\xFF\xFF\x01\x00")), null);
    assert.equal(pictureSize(bytes("not a picture")), null);
  });
});

describe("names and classes follow the service", () => {
  test("classes", () => {
    const cases = [
      ["shot.png", "MZ\x90\0", "executable"],
      ["run.sh", "#!/bin/sh", "executable"],
      ["tool", "\xCF\xFA\xED\xFE", "executable"],
      ["notes.txt.lnk", "L\0\0\0", "executable"],
      ["setup.exe. ", "text", "executable"],
      ["shot.jpg", "\xFF\xD8\xFF\xE0", "image"],
      ["logo.svg", "<svg xmlns", "other"],
      ["clip.mp4", "\0\0\0\x20ftypisom", "video"],
      ["clip.webm", "\x1A\x45\xDF\xA3", "video"],
      ["maps.pk3", "PK\x03\x04", "archive"],
      ["mods.7z", "7z\xBC\xAF\x27\x1C", "archive"],
      ["duel.dm_26", "\x01\x02", "demo"],
      ["binds.cfg", 'bind x "say hi"\n', "config"],
      ["binds.cfg", "bind\0x", "other"],
      ["readme", "hello", "other"],
    ];
    for (const [name, head, expected] of cases) assert.equal(classify(name, bytes(head)), expected, name);
    // A character cut by the end of the head is still text.
    assert.equal(classify("ru.cfg", new Uint8Array(Buffer.from("бинд", "utf8")).subarray(0, 7)), "config");
    assert.equal(isText(new Uint8Array([0x61, 0x80])), false);
  });

  test("names are cleaned like the service cleans them", () => {
    assert.equal(sanitizeName("..\\..\\evil/..\\name.txt"), "....evil..name.txt");
    assert.equal(sanitizeName("report.pdf\u202Eexe.txt"), "report.pdfexe.txt");
    assert.equal(sanitizeName("trailing. . "), "trailing");
    assert.equal(sanitizeName("CON.txt"), "file");
    assert.equal(sanitizeName("com7"), "file");
    assert.equal(sanitizeName("compass.cfg"), "compass.cfg");
    assert.equal(sanitizeName("  \u0007 "), "file");
    assert.equal([...sanitizeName("x".repeat(300))].length, 120);
  });

  test("a program needs a confirmation whatever it is called", () => {
    assert.deepEqual(dangerReasons("tool.exe", bytes("text"), false), ["tool.exe is a program"]);
    assert.deepEqual(dangerReasons("shot.png", bytes("MZ\x90"), false), ["shot.png is a program"]);
    assert.deepEqual(dangerReasons("notes.txt", bytes("hello"), true), ["notes.txt is a program"]);
    assert.deepEqual(dangerReasons("notes.txt", bytes("hello"), false), []);
    // Programs of Android, macOS and Linux ask too, without a byte to tell them.
    for (const name of ["update.apk", "fix.command", "run.sh", "app.dmg", "a.deb", "x.pkg", "tool.AppImage", "open.desktop"]) {
      assert.deepEqual(dangerReasons(name, bytes("PK\x03\x04"), false), [`${name} is a program`], name);
    }
    // Their class stays the service's.
    assert.equal(classify("update.apk", bytes("PK\x03\x04")), "archive");
  });
});

// ---------------------------------------------------------------------------
// The files of the core against a fake service
// ---------------------------------------------------------------------------

function fakeService() {
  const calls = [];
  const stored = new Map();
  /** The hashes whose bytes went up, and the hash of each registered id. */
  const hashes = new Set();
  const hashOf = new Map();
  let next = 1;
  const routes = {
    registerAnswer: null,
    downloadAnswer: null,
  };
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ method: init.method ?? "GET", path, headers: init.headers ?? {}, body: init.body });
    if (path === "/v1/chat/files" && init.method === "POST") {
      if (routes.registerAnswer !== null) return routes.registerAnswer();
      const body = JSON.parse(init.body);
      const id = `F${String(next++).padStart(25, "0")}`;
      hashOf.set(id, body.sha256);
      const needsUpload = !hashes.has(body.sha256);
      return Response.json(
        { file: { id, name: body.name, size: body.size, mediaType: "application/octet-stream", class: "other", danger: false, meta: body.meta ?? null }, needsUpload },
        { status: 201 },
      );
    }
    const content = /^\/v1\/chat\/files\/([^/]+)\/content$/.exec(path);
    if (content !== null) {
      if (routes.downloadAnswer !== null) return routes.downloadAnswer(content[1]);
      const blob = stored.get(content[1]);
      if (blob === undefined) return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
      return new Response(blob, { status: 200, headers: { "content-length": String(blob.size), "content-type": "image/png" } });
    }
    return Response.json({ error: { code: "not_found", message: "No such endpoint" } }, { status: 404 });
  };
  const puts = [];
  const put = async (url, token, body, onProgress) => {
    puts.push({ url, token, size: body.size });
    onProgress(Math.floor(body.size / 2));
    onProgress(body.size);
    const id = /\/v1\/chat\/files\/([^/]+)\/content$/.exec(new URL(url).pathname)[1];
    stored.set(id, body);
    hashes.add(hashOf.get(id));
    return { status: 200, text: "{}" };
  };
  return { calls, puts, stored, routes, fetchImpl, put };
}

function filesWith(service, overrides = {}) {
  const events = new EventBus();
  const heard = [];
  for (const name of ["chat:files-staged", "chat:upload", "chat:download"]) events.on(name, (payload) => heard.push([name, payload]));
  let unauthorized = 0;
  let urls = 0;
  const revoked = [];
  const downloads = [];
  const held = new Set();
  let token = TOKEN;
  const http = createHttp({ apiBase: API, token: () => token, onUnauthorized: () => (unauthorized += 1), fetchImpl: service.fetchImpl });
  const files = createChatFiles({
    http,
    events,
    storage: memoryStorage(),
    token: () => token,
    onUnauthorized: () => (unauthorized += 1),
    held: (handle) => held.has(handle),
    caches: null,
    fetchImpl: service.fetchImpl,
    put: service.put,
    measure: async () => null,
    download: (url, name) => downloads.push({ url, name }),
    createObjectURL: () => `blob:${API}/${++urls}`,
    revokeObjectURL: (url) => revoked.push(url),
    ...overrides,
  });
  return {
    files,
    heard,
    held,
    revoked,
    downloads,
    unauthorized: () => unauthorized,
    setToken: (value) => (token = value),
  };
}

function file(content, name, type = "") {
  return new File([content], name, { type });
}

async function flush() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("staging", () => {
  test("a picture is staged stripped, measured and hashed, and the page hears it", async () => {
    const service = fakeService();
    const { files, heard } = filesWith(service);
    const staged = await files.stage([file(jpegWithGps(), "shot.jpg", "image/jpeg")], "clipboard");
    assert.equal(staged.refused.length, 0);
    const [one] = staged.files;
    assert.equal(one.name, "shot.jpg");
    assert.equal(one.classGuess, "image");
    assert.equal(one.origin, "clipboard");
    assert.deepEqual([one.width, one.height], [16, 8]);
    assert.equal(one.size, stripMetadata(jpegWithGps()).length);
    assert.deepEqual(heard[0], ["chat:files-staged", staged]);
    const [record] = files.records([one.handle]);
    const kept = new Uint8Array(await record.blob.arrayBuffer());
    assert.ok(!contains(kept, GPS_RATIONALS));
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", kept)).toString("hex");
    assert.equal(record.sha256, digest);
    assert.deepEqual(record.meta, { origin: "clipboard", width: 16, height: 8 });
    assert.equal(files.busy(), true);
  });

  test("more than 25 MiB, an empty file, the eleventh file and the session token are refused", async () => {
    const { files } = filesWith(fakeService());
    const big = new File([new Uint8Array(MAX_FILE_BYTES + 1)], "big.bin");
    const exact = new File([new Uint8Array(MAX_FILE_BYTES)], "exact.bin");
    const staged = await files.stage([big, exact, file("", "empty.txt"), file(`token=${TOKEN}`, "settings copy.txt")], "file");
    assert.deepEqual(staged.files.map((one) => one.name), ["exact.bin"]);
    assert.deepEqual(staged.refused.map((one) => one.name), ["big.bin", "empty.txt", "settings copy.txt"]);
    assert.match(staged.refused[0].error.message, /25\.0 MiB, and a chat file is at most 25 MiB/);
    assert.equal(staged.refused[0].error.code, "invalidInput");
    assert.match(staged.refused[1].error.message, /empty/);
    assert.match(staged.refused[2].error.message, /holds the JKNet session/);

    const eleven = Array.from({ length: 11 }, (_, index) => file(`file ${index}`, `f${index}.txt`));
    const many = await files.stage(eleven, "file");
    assert.equal(many.files.length, 10);
    assert.deepEqual(many.refused.map((one) => one.name), ["f10.txt"]);
    assert.match(many.refused[0].error.message, /at most 10 files/);
  });

  test("a file taken back goes, unless a queued message still carries it", async () => {
    const { files, held } = filesWith(fakeService());
    const { files: [a, b] } = await files.stage([file("a", "a.txt"), file("b", "b.txt")], "file");
    held.add(b.handle);
    files.unstage(a.handle);
    files.unstage(b.handle);
    assert.equal(files.records([a.handle]).length, 0);
    assert.equal(files.records([b.handle]).length, 1);
  });

  test("the staged files of a queued message come back after a reload", async () => {
    const first = filesWith(fakeService());
    const { files: [one] } = await first.files.stage([file("hello", "a.txt")], "file");
    const rows = structuredClone(first.files.records([one.handle]));
    const second = filesWith(fakeService());
    second.files.restore(rows);
    assert.deepEqual(second.files.records([one.handle]).map((row) => row.name), ["a.txt"]);
  });
});

describe("upload", () => {
  test("a file is registered, then its bytes go up with the token and the progress", async () => {
    const service = fakeService();
    const { files, heard } = filesWith(service);
    const { files: [one] } = await files.stage([file("hello world", "a.txt")], "file");
    const fileId = await files.upload(CONVERSATION, one.handle);
    const register = service.calls.find((call) => call.path === "/v1/chat/files");
    assert.equal(register.headers.Authorization, `Bearer ${TOKEN}`);
    const body = JSON.parse(register.body);
    assert.deepEqual(Object.keys(body).sort(), ["conversationId", "meta", "name", "sha256", "size"]);
    assert.equal(body.conversationId, CONVERSATION);
    assert.equal(service.puts.length, 1);
    assert.equal(service.puts[0].token, TOKEN);
    assert.equal(service.puts[0].url, `${API}/v1/chat/files/${fileId}/content`);
    const uploads = heard.filter(([name]) => name === "chat:upload").map(([, event]) => event);
    assert.deepEqual(uploads.at(-1), { handle: one.handle, sent: one.size, total: one.size });
  });

  test("bytes the account stored already are not sent again", async () => {
    const service = fakeService();
    const { files } = filesWith(service);
    const { files: [a, b] } = await files.stage([file("same", "a.txt"), file("same", "b.txt")], "file");
    await files.upload(CONVERSATION, a.handle);
    await files.upload(CONVERSATION, b.handle);
    assert.equal(service.puts.length, 1);
  });

  test("the quota and the size limit of the service come back as their codes", async () => {
    const service = fakeService();
    const { files } = filesWith(service);
    const { files: [one] } = await files.stage([file("x", "a.txt")], "file");
    service.routes.registerAnswer = () =>
      Response.json(
        { error: { code: "invalid", message: "Your chat files take 1 of 1 bytes", details: { reason: "quota_account", usedBytes: 1, quotaBytes: 1 } } },
        { status: 400 },
      );
    await assert.rejects(files.upload(CONVERSATION, one.handle), (error) => error.details.code === "quota_account");
    service.routes.registerAnswer = () =>
      Response.json({ error: { code: "invalid", message: "A chat file holds 1 to 26214400 bytes", details: { reason: "file_too_large" } } }, { status: 400 });
    await assert.rejects(files.upload(CONVERSATION, one.handle), (error) => error.details.code === "file_too_large");
  });

  test("a refused upload of the bytes says why, and a 401 signs out", async () => {
    const service = fakeService();
    const { files, unauthorized } = filesWith(service, {
      put: async () => ({ status: 401, text: JSON.stringify({ error: { code: "unauthorized", message: "no" } }) }),
    });
    const { files: [one] } = await files.stage([file("x", "a.txt")], "file");
    await assert.rejects(files.upload(CONVERSATION, one.handle), (error) => error.details.code === "unauthorized");
    assert.equal(unauthorized(), 1);
  });

  test("a file no longer staged cannot go up", async () => {
    const { files } = filesWith(fakeService());
    await assert.rejects(files.upload(CONVERSATION, "01HGONE000000000000000000"), (error) => error.code === "invalidInput");
  });

  test("a sent file is the sender's cached copy: it never comes back down", async () => {
    const service = fakeService();
    const { files } = filesWith(service);
    const { files: [one] } = await files.stage([file("mine", "a.txt")], "file");
    const fileId = await files.upload(CONVERSATION, one.handle);
    files.settleSent([[one.handle, fileId]]);
    assert.equal(files.busy(), false);
    const local = await files.local(fileId, false);
    assert.equal(local.status, "cached");
    assert.match(local.path, /^blob:/);
    assert.equal(service.calls.filter((call) => call.path.endsWith("/content")).length, 0);
  });
});

test("a file the sender's message frame shows before the send settles is the cached copy, not a download", async () => {
  const service = fakeService();
  const { files, heard } = filesWith(service);
  const { files: [one] } = await files.stage([file("mine", "a.txt")], "file");
  const fileId = await files.upload(CONVERSATION, one.handle);
  // The frame of the message came first: the thread asks while the send settles.
  const asked = files.local(fileId, true);
  files.settleSent([[one.handle, fileId]]);
  assert.equal((await asked).status, "cached");
  await flush();
  assert.equal(heard.filter(([name]) => name === "chat:download").length, 0);
  assert.equal(service.calls.filter((call) => call.path.endsWith("/content")).length, 0);
});

describe("download and save", () => {
  test("a file downloads on request with the token, and is cached afterwards", async () => {
    const service = fakeService();
    service.stored.set("FILE1", new Blob([png(4, 3)], { type: "image/png" }));
    const { files, heard } = filesWith(service);
    assert.deepEqual(await files.local("FILE1", false), { status: "remote", path: null });
    assert.deepEqual(await files.local("FILE1", true), { status: "downloading", path: null });
    await flush();
    const events = heard.filter(([name]) => name === "chat:download").map(([, event]) => event);
    assert.equal(events.at(-1).status, "cached");
    assert.match(events.at(-1).path, /^blob:/);
    const download = service.calls.find((call) => call.path === "/v1/chat/files/FILE1/content");
    assert.equal(download.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal((await files.local("FILE1", false)).status, "cached");
    assert.equal(service.calls.filter((call) => call.path.endsWith("/content")).length, 1);
  });

  test("a file the service lost is gone for good; another failure may be tried again", async () => {
    const service = fakeService();
    const { files, heard } = filesWith(service);
    await files.local("LOST", true);
    await flush();
    assert.equal(heard.filter(([name]) => name === "chat:download").at(-1)[1].status, "gone");
    assert.deepEqual(await files.local("LOST", true), { status: "gone", path: null });

    service.routes.downloadAnswer = () => Response.json({ error: { code: "internal", message: "boom" } }, { status: 500 });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await files.local("FLAKY", true);
      await flush();
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(heard.filter(([name]) => name === "chat:download").at(-1)[1].status, "remote");
    assert.equal((await files.local("FLAKY", false)).status, "remote");
  });

  test("a download whose body stops moving is cut, and the file can be asked for again", async () => {
    const service = fakeService();
    let aborted = false;
    service.routes.downloadAnswer = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            // Then nothing, ever: a connection left half-open.
          },
        }),
        { status: 200, headers: { "content-length": "100" } },
      );
    const { files, heard } = filesWith(service, {
      stallMs: 40,
      fetchImpl: async (url, init) => {
        init.signal?.addEventListener("abort", () => (aborted = true));
        return service.fetchImpl(url, init);
      },
    });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal((await files.local("STALL", true)).status, "downloading");
      await new Promise((resolve) => setTimeout(resolve, 150));
      await flush();
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(heard.filter(([name]) => name === "chat:download").at(-1)[1].status, "remote");
    assert.equal((await files.local("STALL", false)).status, "remote", "not downloading for good");
    assert.ok(aborted, "the request is aborted");
  });

  test("a download of a file this device sent is checked against its hash", async () => {
    const service = fakeService();
    const { files } = filesWith(service);
    const { files: [one] } = await files.stage([file("the real bytes", "a.txt")], "file");
    const fileId = await files.upload(CONVERSATION, one.handle);
    service.routes.downloadAnswer = () => new Response("forged bytes!!", { status: 200 });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await assert.rejects(files.save(fileId, false), /does not match its hash/);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("a program asks first; confirmed, the browser saves it under its name", async () => {
    const service = fakeService();
    service.stored.set("EXE1", new Blob([bytes("MZ\x90\0rest of a program")]));
    const { files, downloads } = filesWith(service);
    files.remember([{ files: [{ id: "EXE1", name: "tool.exe", size: 20, mediaType: "application/octet-stream", class: "executable", danger: true, meta: null }] }]);
    await assert.rejects(files.save("EXE1", false), (error) => error.code === "online" && error.details.code === CONFIRM_DANGER && error.details.message === "tool.exe is a program");
    assert.equal(downloads.length, 0);
    assert.equal(await files.save("EXE1", true), "tool.exe");
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].name, "tool.exe");
    assert.match(downloads[0].url, /^blob:/);
  });

  test("a harmless file saves at once, under a name the service would keep", async () => {
    const service = fakeService();
    service.stored.set("TXT1", new Blob(["hello"]));
    const { files, downloads } = filesWith(service);
    files.remember([{ files: [{ id: "TXT1", name: "notes\u202E.txt", size: 5, mediaType: "text/plain", class: "other", danger: false, meta: null }] }]);
    assert.equal(await files.save("TXT1", false), "notes.txt");
    assert.deepEqual(downloads.map((one) => one.name), ["notes.txt"]);
  });

  test("at most a hundred blob: addresses live at once, the oldest goes", async () => {
    const service = fakeService();
    for (let index = 0; index <= MAX_OBJECT_URLS; index += 1) service.stored.set(`F${index}`, new Blob([`file ${index}`]));
    const { files, revoked } = filesWith(service);
    for (let index = 0; index <= MAX_OBJECT_URLS; index += 1) await files.save(`F${index}`, true);
    assert.equal(revoked.length, 1);
  });

  test("sign-out forgets every address and every staged file", async () => {
    const service = fakeService();
    service.stored.set("F1", new Blob(["x"]));
    const { files, revoked } = filesWith(service);
    await files.stage([file("a", "a.txt")], "file");
    await files.save("F1", true);
    files.forget();
    assert.equal(files.busy(), false);
    assert.equal(revoked.length, 1);
    assert.equal((await files.local("F1", false)).status, "remote");
  });
});

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

const BUNDLE_ID = "01J9Z3M2K4V8Q6R5T7W9X1Y2Z3";

describe("cards the web app builds", () => {
  test("a server card is cleaned and gets its English fallback", () => {
    const card = buildCard({ type: "server", address: " 203.0.113.7:29070 ", name: "^1Clan\u202E server", game: "ja", map: "mp/ffa3", gametype: 0, mod: null });
    assert.deepEqual(card, {
      type: "server",
      v: 1,
      fallbackText: "Server: ^1Clan server (203.0.113.7:29070)",
      address: "203.0.113.7:29070",
      name: "^1Clan server",
      game: "ja",
      map: "mp/ffa3",
      gametype: 0,
    });
  });

  test("a bundle and a JKHub mod card follow the service's rules", () => {
    assert.deepEqual(buildCard({ type: "bundle", bundleId: BUNDLE_ID.toLowerCase(), slug: "clan-pack", name: "Clan pack", game: "jo" }), {
      type: "bundle",
      v: 1,
      fallbackText: "Bundle: Clan pack",
      bundleId: BUNDLE_ID,
      slug: "clan-pack",
      name: "Clan pack",
      game: "jo",
    });
    const mod = buildCard({ type: "jkhubMod", v: 1, fallbackText: "", fileId: 4321, slug: "4321-hilt", title: "Hilt", game: "ja" });
    assert.equal(mod.fallbackText, "JKHub: Hilt");
  });

  test("what the service refuses is refused here with its code", () => {
    const refused = (card, reason) =>
      assert.throws(() => buildCard(card), (error) => error.code === "online" && error.details.code === CARD && reason.test(error.details.message));
    refused({ type: "server", address: "127.0.0.1:29070", name: "x", game: "ja" }, /not a server address/);
    refused({ type: "server", address: "localhost:29070", name: "x", game: "ja" }, /not a server address/);
    refused({ type: "server", address: "203.0.113.7", name: "x", game: "ja" }, /not a server address/);
    refused({ type: "server", address: "203.0.113.7:29070", name: "x", game: "ja", password: "secret" }, /no field "password"/);
    refused({ type: "server", address: "203.0.113.7:29070", name: " ", game: "ja" }, /name is empty/);
    refused({ type: "server", address: "203.0.113.7:29070", name: "x", game: "q3" }, /game must be/);
    refused({ type: "bundle", bundleId: "not-a-ulid", slug: "a", name: "x", game: "ja" }, /ULID/);
    refused({ type: "bundle", bundleId: BUNDLE_ID, slug: "Clan Pack", name: "x", game: "ja" }, /slug/);
    refused({ type: "jkhubMod", fileId: 0, slug: "a", title: "x", game: "ja" }, /JKHub file/);
    refused({ type: "jkhubMod", fileId: 12, slug: "a/b", title: "x", game: "ja" }, /JKHub slug/);
    refused({ type: "server", v: 2, address: "203.0.113.7:29070", name: "x", game: "ja" }, /version 1 only/);
    refused({ type: "map", game: "ja", name: "mp/ffa3" }, /builds server, bundle and JKHub mod cards only/);
  });

  test("a message carries at most five cards and 48 KiB of them", () => {
    const server = { type: "server", address: "203.0.113.7:29070", name: "x", game: "ja" };
    assert.equal(prepareCards([server, server, server, server, server]).length, 5);
    assert.throws(() => prepareCards([server, server, server, server, server, server]), (error) => error.details.code === CARD);
    const config = { type: "config", name: "big.cfg", text: "x".repeat(30 * 1024) };
    assert.throws(() => prepareCards([config, config]), (error) => /larger than 49152 bytes/.test(error.details.message));
  });

  test("addresses: public IPv4 and host names pass; this machine, link-local, multicast and broadcast do not", () => {
    assert.equal(serverAddress("server.example.com:29070"), "server.example.com:29070");
    for (const bad of ["0.0.0.0:1", "169.254.1.1:1", "224.0.0.1:1", "255.255.255.255:1", "10.0.0.01:1", "a..b:1", "host:0", "host:70000", "1.2.3:1"]) {
      assert.throws(() => serverAddress(bad), undefined, bad);
    }
  });
});

describe("cards a message brought", () => {
  test("the web's kinds are checked by the rules; the others keep only the fields of their type", () => {
    assert.equal(checkCard({ type: "server", v: 1, fallbackText: "S", address: "203.0.113.7:29070", name: "x", game: "ja", extra: 1 }).extra, undefined);
    assert.throws(() => checkCard({ type: "server", v: 1, fallbackText: "S", address: "127.0.0.1:29070", name: "x", game: "ja" }));
    const invite = checkCard({ type: "hostInvite", v: 1, fallbackText: "Join", sessionId: "0123456789abcdef", hostId: "01H", game: "ja", secret: "x" });
    assert.deepEqual(invite, { type: "hostInvite", v: 1, fallbackText: "Join", sessionId: "0123456789abcdef", hostId: "01H", game: "ja" });
    assert.throws(() => checkCard({ type: "weather", v: 1 }), (error) => error.details.code === CARD);
  });
});

// ---------------------------------------------------------------------------
// Friends' server chats, and the engine registry
// ---------------------------------------------------------------------------

describe("the chats of friends' servers", () => {
  test("rows are read leniently and never carry an address", () => {
    assert.deepEqual(readJoinable({ hostUserId: "H", sessionId: "0123456789abcdef", game: "ja", map: "mp/ffa3", mod: null, gametype: 7, members: 3, invited: true, address: "203.0.113.7:29070" }), {
      hostUserId: "H",
      sessionId: "0123456789abcdef",
      game: "ja",
      map: "mp/ffa3",
      mod: null,
      gametype: 7,
      members: 3,
      invited: true,
    });
    assert.equal(readJoinable({ sessionId: "x" }), null);
  });

  test("the list is asked again when a friend's hosting changes, the frame says so or the socket opens", async () => {
    const events = new EventBus();
    let heard = 0;
    events.on(JOINABLE_EVENT, () => (heard += 1));
    const calls = [];
    const http = createHttp({
      apiBase: API,
      token: () => TOKEN,
      onUnauthorized: () => {},
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith("/joinable")) return Response.json({ servers: [{ hostUserId: "H", sessionId: "0123456789abcdef", game: "jo", map: "", mod: null, gametype: 0, members: 1, invited: false }] });
        return Response.json({ id: "C1", kind: "server", members: [], lastSeq: 0, readSeq: 0, createdAt: "2026-09-28T10:00:00Z" });
      },
    });
    const kept = [];
    const chats = createServerChats({ http, events, signedIn: () => true, keep: (conversation) => kept.push(conversation) });
    events.emit(EVENTS.friendsPresence, { userId: "H", presence: { status: "online" } });
    assert.equal(heard, 0, "a friend first seen without a server changes nothing");
    events.emit(EVENTS.friendsPresence, { userId: "H", presence: { status: "online", hosting: { sessionId: "0123456789abcdef" } } });
    events.emit(EVENTS.friendsPresence, { userId: "H", presence: { status: "online", hosting: { sessionId: "0123456789abcdef" } } });
    assert.equal(heard, 1);
    assert.equal(chats.handleFrame({ type: "chat.serverJoinable", payload: {} }), true);
    assert.equal(chats.handleFrame({ type: "chat.message", payload: {} }), false);
    chats.connected();
    assert.equal(heard, 3);
    const [row] = await chats.joinable();
    assert.equal(row.game, "jo");
    const conversation = await chats.join("H", "0123456789abcdef");
    assert.equal(conversation.id, "C1");
    assert.equal(kept.length, 1);
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), { hostUserId: "H" });
    assert.ok(calls.at(-1).url.endsWith("/v1/chat/servers/0123456789abcdef/join"));
  });

  test("the host's switch, its policy and its map count as a change; its player count does not", () => {
    const events = new EventBus();
    let heard = 0;
    events.on(JOINABLE_EVENT, () => (heard += 1));
    const chats = createServerChats({ http: createHttp({ apiBase: API, token: () => TOKEN, onUnauthorized: () => {} }), events, signedIn: () => true, keep: () => {} });
    const hosting = { sessionId: "0123456789abcdef", game: "ja", map: "mp/ffa3", mod: null, gametype: 0, players: 1, maxPlayers: 8, joinPolicy: "friends", canJoin: true };
    const beat = (extra) => events.emit(EVENTS.friendsPresence, { userId: "H", presence: { status: "online", hosting: { ...hosting, ...extra } } });
    beat({});
    assert.equal(heard, 1);
    beat({ players: 5 });
    assert.equal(heard, 1, "more players change nothing");
    beat({ chatFromWeb: true });
    assert.equal(heard, 1, "an explicit yes is the default");
    beat({ chatFromWeb: false });
    assert.equal(heard, 2, "the host switched web joins off");
    beat({ chatFromWeb: false, joinPolicy: "invite", canJoin: false });
    assert.equal(heard, 3, "the policy closed the server");
    beat({ chatFromWeb: false, joinPolicy: "invite", canJoin: false, map: "mp/duel1" });
    assert.equal(heard, 4, "another map");
    events.emit(EVENTS.friendsPresence, { userId: "H", presence: { status: "offline", hosting: { ...hosting } } });
    assert.equal(heard, 5, "an offline host hosts nothing");
    assert.equal(hostingKey({ status: "online" }), null);

    // A reconnect reads the list again, and the next word of a hosting
    // friend counts as the first: what went unheard meanwhile is unknown.
    beat({});
    assert.equal(heard, 6);
    chats.connected();
    assert.equal(heard, 7);
    beat({});
    assert.equal(heard, 8);
  });
});

test("the engine registry is the launcher's", () => {
  const rust = readFileSync(new URL("../../../../src-tauri/src/engines.rs", import.meta.url), "utf8");
  const ids = [...rust.matchAll(/^\s+id: "([a-z0-9]+)",$/gm)].map((match) => match[1]);
  assert.deepEqual(ENGINES.map((engine) => engine.id), ids);
  for (const engine of ENGINES) {
    assert.ok(rust.includes(`name: "${engine.name}",`), engine.name);
    assert.ok(rust.includes(`repo_url: "${engine.repoUrl}",`), engine.repoUrl);
  }
  assert.deepEqual(neutralAnswer("list_engines", { game: "jo" }).value.map((engine) => engine.id), ["jk2mv"]);
});
