/**
 * Files of the chat in the web app: what the player attaches, and what the
 * others sent. The port of the launcher's `src-tauri/src/chat/files.rs` onto
 * what a browser has: `File` objects instead of paths, Cache Storage instead
 * of a cache folder, `blob:` addresses instead of the asset protocol.
 *
 * A file reaches a message only through the core. The page hands over the
 * `File` objects it picked, pasted or had dropped on it; the core stages
 * each one — reads it, strips what a picture records about where and when it
 * was taken, hashes the copy — and the composer keeps only an opaque handle.
 * The outbox uploads the copy and sends the message; the copy then becomes
 * the cached copy of the id the service gave the file, so the sender never
 * downloads it back.
 *
 * | Step     | What happens |
 * | -------- | ------------ |
 * | stage    | refuses more than 25 MiB before reading, an empty file, the 11th file of one batch, and any file whose bytes hold the session token; strips JPEG `APP1`/`APP13` and PNG `eXIf`/`tEXt`/`iTXt`/`zTXt` (`exif.ts`); measures a picture; hashes the copy with SHA-256; `chat:files-staged` |
 * | upload   | registers the file (`POST /v1/chat/files`: the service's 25 MiB and account quota answer here), then sends the bytes with `XMLHttpRequest` unless the account stored them already; `chat:upload` at most every 250 ms |
 * | download | `fetch` with the token in the `Authorization` header — files are never public addresses — checked against the SHA-256 when this device uploaded the file; into Cache Storage `jknet-files-v1`, at most 200 MB, the files shown least recently go first; shown as a `blob:` address; `chat:download` |
 * | save     | a program, by the service's word, its name or its first bytes, is refused with `confirm_danger` until confirmed; then the browser's own download of the `blob:` address, under the file's name |
 *
 * No archive is looked into and nothing is imported into a game: the web
 * app has neither. Nothing here opens a received file.
 */

import type {
  ChatFileClass,
  ChatFileLocal,
  ChatFileMeta,
  ChatFileRef,
  ChatFilesStagedEvent,
  ChatMessage,
  ChatStagedFile,
  ChatStageRefusal,
  ChatWebFileOrigin,
} from "../../../../src/lib/ipc.ts";
import { CoreError, invalidInput, networkError, onlineError, serviceCode, signedOut } from "../errors.ts";
import type { EventBus } from "../events.ts";
import { refusal, segment, type Http } from "../http.ts";
import type { Storage } from "../storage.ts";
import { MAX_ATTACHMENTS } from "./drafts.ts";
import { MAX_PICTURE_SIDE, pictureSize, pictureType, stripMetadata } from "./exif.ts";
import { CHAT_EVENTS } from "./frames.ts";
import { newClientId } from "./outbox.ts";

/** The largest file chat carries, the service's default limit. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** The longest name the service keeps. */
export const MAX_NAME_CHARS = 120;
/** The Cache Storage of downloaded files; `index.ts` deletes every `jknet-files-*` on sign-out. */
export const FILE_CACHE = "jknet-files-v1";
/** How much of the download cache stays. */
export const CACHE_LIMIT = 200 * 1024 * 1024;
/** `blob:` addresses kept alive at once; the oldest is let go past this. */
export const MAX_OBJECT_URLS = 100;
/** How often `chat:upload` and `chat:download` go out for one file. */
export const PROGRESS_EVERY_MS = 250;
/** File refs remembered for saves; past this the memory starts over. */
export const KNOWN_LIMIT = 10_000;
/** The code of a save the player has to confirm first, as the launcher's core refuses one. */
export const CONFIRM_DANGER = "confirm_danger";
/** How much of a file tells its class and whether it is a program. */
const HEAD_BYTES = 4096;

/** Extensions the service classifies as programs whatever the bytes say. */
const PROGRAM_EXTENSIONS = new Set([
  "exe", "com", "scr", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh",
  "hta", "msi", "msp", "msix", "appx", "lnk", "url", "pif", "cpl", "dll", "sys", "inf", "reg",
  "jar", "scf", "chm", "iso", "img", "vhd", "vhdx", "application", "gadget", "xll", "docm",
  "xlsm", "pptm",
]);

/** Magic numbers of Mach-O programs, both byte orders, and of fat binaries. */
const MACH_O = [
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
];

// ---------------------------------------------------------------------------
// Names and classes: the rules of the service, as the launcher keeps them
// ---------------------------------------------------------------------------

function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function isUnsafeNameChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    '\\/:*?"<>|'.includes(char) ||
    isControl(code) ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x061c ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** Rust's `char::is_whitespace`: the Unicode `White_Space` property. */
const WHITE_SPACE_CODES = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];

function isWhite(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return WHITE_SPACE_CODES.includes(code) || (code >= 0x2000 && code <= 0x200a);
}

function trimStartWhite(text: string): string {
  const chars = [...text];
  let start = 0;
  while (start < chars.length && isWhite(chars[start])) start += 1;
  return chars.slice(start).join("");
}

/**
 * The name the service will keep, cleaned the same way: no path separators,
 * no control or bidi characters, no trailing dots or spaces, no reserved
 * Windows device name, at most 120 characters.
 */
export function sanitizeName(name: string): string {
  const cleaned = [...name].filter((char) => !isUnsafeNameChar(char)).slice(0, MAX_NAME_CHARS).join("");
  const trimmed = trimStartWhite(cleaned.replace(/[. ]+$/, ""));
  const stem = (trimmed.split(".")[0] ?? "").trimEnd().toLowerCase();
  const reserved =
    ["con", "prn", "aux", "nul"].includes(stem) ||
    ((stem.startsWith("com") || stem.startsWith("lpt")) && stem.length === 4 && /[1-9]/.test(stem[3]));
  return trimmed === "" || reserved ? "file" : trimmed;
}

/**
 * The final extension, lower case, ignoring the trailing dots and spaces
 * Windows drops from a name anyway.
 */
export function extension(name: string): string | null {
  const trimmed = name.replace(/[. ]+$/, "");
  const file = trimmed.split(/[/\\]/).pop() ?? trimmed;
  const at = file.lastIndexOf(".");
  if (at < 0) return null;
  const ext = file.slice(at + 1);
  return ext === "" ? null : ext.toLowerCase();
}

function startsWith(bytes: Uint8Array, prefix: ArrayLike<number>, at = 0): boolean {
  if (bytes.length < at + prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[at + index] !== prefix[index]) return false;
  }
  return true;
}

function ascii(text: string): number[] {
  return Array.from(text, (char) => char.charCodeAt(0));
}

/** Whether bytes are a program, or a name that Windows would run. */
export function isProgram(name: string, head: Uint8Array): boolean {
  const ext = extension(name);
  return (
    startsWith(head, ascii("MZ")) ||
    startsWith(head, [0x7f, 0x45, 0x4c, 0x46]) ||
    startsWith(head, ascii("#!")) ||
    MACH_O.some((magic) => startsWith(head, magic)) ||
    (ext !== null && PROGRAM_EXTENSIONS.has(ext))
  );
}

/**
 * UTF-8 without NUL. A multi-byte character cut by the end of the head is
 * not a reason to call the file binary.
 */
export function isText(head: Uint8Array): boolean {
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head);
    return true;
  } catch {
    // A character cut at the very end: decode without the last three bytes.
    for (let cut = 1; cut <= 3 && cut < head.length; cut += 1) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, head.length - cut));
        return incompleteTail(head.subarray(head.length - cut));
      } catch {
        // Try one byte more.
      }
    }
    return false;
  }
}

/** Whether bytes are the start of one UTF-8 character and nothing else. */
function incompleteTail(tail: Uint8Array): boolean {
  const lead = tail[0];
  const needs = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 0;
  if (needs === 0 || tail.length >= needs) return false;
  return tail.subarray(1).every((byte) => (byte & 0xc0) === 0x80);
}

function archiveKind(head: Uint8Array): "zip" | "rar" | "7z" | null {
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return "zip";
  if (startsWith(head, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return "rar";
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "7z";
  return null;
}

/**
 * The class the service gives bytes, told the same way from the name and
 * the first bytes. A program is told first, and an SVG is never a picture.
 */
export function classify(name: string, head: Uint8Array): ChatFileClass {
  if (isProgram(name, head)) return "executable";
  if (pictureType(head) !== null) return "image";
  if (startsWith(head, ascii("ftyp"), 4) || startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return "video";
  if (archiveKind(head) !== null) return "archive";
  const ext = extension(name);
  if (ext === "dm_25" || ext === "dm_26" || ext === "dm_15") return "demo";
  if (ext === "cfg" && isText(head)) return "config";
  return "other";
}

/** Why a file must be confirmed before it is saved; empty when it need not. */
export function dangerReasons(name: string, head: Uint8Array, flagged: boolean): string[] {
  return flagged || isProgram(name, head) ? [`${name} is a program`] : [];
}

/** Whether `needle` occurs in `haystack`: the session token in a file, say. */
export function containsText(haystack: Uint8Array, needle: string): boolean {
  if (needle === "") return false;
  // Every byte becomes one character, so an ASCII needle is found exactly
  // where its bytes are.
  return new TextDecoder("windows-1252").decode(haystack).includes(needle);
}

function sizeRefusal(name: string, size: number): CoreError {
  return invalidInput(`${name} is ${(size / (1024 * 1024)).toFixed(1)} MiB, and a chat file is at most 25 MiB`);
}

async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A refusal as a window reads it: the envelope of an error, never an `Error` object. */
function envelopeOf(error: unknown): ChatStageRefusal["error"] {
  if (error instanceof CoreError) return { code: error.code, message: error.message, details: { ...error.details } };
  return { code: "", message: error instanceof Error ? error.message : String(error), details: {} };
}

/** A path segment of an id the service gave: it never climbs out of its route. */
function fileIdOf(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "" || !/^[A-Za-z0-9_-]+$/.test(trimmed)) throw invalidInput(`file id ${JSON.stringify(trimmed)}`);
  return trimmed;
}

/** The service no longer has the file, or this account may no longer read it. */
export function isGone(error: unknown): boolean {
  const code = serviceCode(error);
  return code === "file_gone" || code === "not_found";
}

// ---------------------------------------------------------------------------
// The files of the core
// ---------------------------------------------------------------------------

/** A staged file: the stripped copy, and what the service is told about it. */
interface Staged {
  handle: string;
  name: string;
  size: number;
  sha256: string;
  blob: Blob;
  meta: ChatFileMeta;
  classGuess: ChatFileClass;
  origin: ChatWebFileOrigin;
}

/** A staged file as the `outbox` row of IndexedDB keeps it. */
export interface StagedRecord {
  handle: string;
  name: string;
  size: number;
  sha256: string;
  blob: Blob;
  meta: ChatFileMeta;
  classGuess?: ChatFileClass;
}

/** How the bytes of a file go up: `XMLHttpRequest` in a browser, for its upload progress. */
export type PutBody = (
  url: string,
  token: string,
  body: Blob,
  onProgress: (sent: number) => void,
) => Promise<{ status: number; text: string }>;

export interface FilesDeps {
  http: Http;
  events: EventBus;
  storage: Storage;
  /** The stored token: sent with every upload and download, and never let out inside a file. */
  token(): string | null;
  /** A `401` of an upload or a download: the token is gone. */
  onUnauthorized(): void;
  /** Whether a queued message still carries a staged file. */
  held(handle: string): boolean;
  /** Cache Storage, `null` in a browser without it: the cache then lives in memory. */
  caches?: CacheStorage | null;
  fetchImpl?: typeof fetch;
  put?: PutBody;
  /** The size of a picture as the browser shows it; `createImageBitmap` in a browser. */
  measure?: (blob: Blob) => Promise<{ width: number; height: number } | null>;
  /** Hands a file to the browser's downloads under a name. */
  download?: (url: string, name: string) => void;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  now?: () => number;
}

export interface WebChatFiles {
  // What the outbox asks (`ChatFiles` of `index.ts`).
  upload(conversationId: string, handle: string): Promise<string>;
  settleSent(uploaded: Array<[string, string]>): void;
  drop(handles: string[]): void;
  records(handles: string[]): StagedRecord[];
  restore(records: unknown[]): void;
  // The commands.
  stage(files: unknown, origin: unknown): Promise<ChatFilesStagedEvent>;
  unstage(handle: string): void;
  local(fileId: string, download: boolean): Promise<ChatFileLocal>;
  save(fileId: string, confirmed: boolean): Promise<string | null>;
  /** The files of messages the screens were given: their names and whether they are programs. */
  remember(messages: ChatMessage[]): void;
  /** Whether a file waits in the composer or on its way up: an update waits for it. */
  busy(): boolean;
  /** The account is gone: every staged file, every address and every memory of it goes. */
  forget(): void;
}

function browserPut(url: string, token: string, body: Blob, onProgress: (sent: number) => void) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => reject(networkError(`PUT ${url}: the upload failed`));
    xhr.onabort = () => reject(networkError(`PUT ${url}: the upload was cut off`));
    xhr.ontimeout = () => reject(networkError(`PUT ${url}: the upload took too long`));
    xhr.send(body);
  });
}

async function browserMeasure(blob: Blob): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

function browserDownload(url: string, name: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/** One row of the cache index, the `files` store. */
interface CacheRow {
  size: number;
  lastUsed: number;
}

export function createChatFiles(deps: FilesDeps): WebChatFiles {
  const { http, events, storage } = deps;
  const fetchImpl = deps.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const put = deps.put ?? browserPut;
  const measure = deps.measure ?? browserMeasure;
  const download = deps.download ?? browserDownload;
  const createUrl = deps.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeUrl = deps.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
  const now = deps.now ?? (() => Date.now());
  const cacheStorage = deps.caches === undefined ? (typeof caches === "undefined" ? null : caches) : deps.caches;

  const staged = new Map<string, Staged>();
  /** What the service said about each file, by id. */
  const known = new Map<string, ChatFileRef>();
  /** The SHA-256 of files this device uploaded, for the check of a later download. */
  const hashes = new Map<string, string>();
  /** Files the service answered it no longer has. */
  const gone = new Set<string>();
  /** Downloads on their way, by file id. */
  const inflight = new Map<string, Promise<Blob>>();
  /** The bytes shown, by file id, oldest first: their `blob:` addresses. */
  const shown = new Map<string, { blob: Blob; url: string }>();
  let uploading = 0;
  /** Bumped when the account goes: a download for the account before keeps nothing. */
  let generation = 0;

  const emit = (event: string, payload: unknown) => events.emit(event, payload);

  // -- The blob: addresses ------------------------------------------------

  const urlFor = (fileId: string, blob: Blob): string => {
    const current = shown.get(fileId);
    if (current !== undefined) {
      shown.delete(fileId);
      shown.set(fileId, current);
      return current.url;
    }
    const url = createUrl(blob);
    shown.set(fileId, { blob, url });
    while (shown.size > MAX_OBJECT_URLS) {
      const [oldest, entry] = shown.entries().next().value as [string, { blob: Blob; url: string }];
      shown.delete(oldest);
      revokeUrl(entry.url);
    }
    return url;
  };

  // -- Cache Storage ------------------------------------------------------

  const cacheKey = (fileId: string) => http.url(`/v1/chat/files/${segment(fileId)}/content`);

  const openCache = async (): Promise<Cache | null> => {
    if (cacheStorage === null) return null;
    try {
      return await cacheStorage.open(FILE_CACHE);
    } catch (error) {
      console.warn("Opening the file cache failed", error);
      return null;
    }
  };

  const touch = (fileId: string, size: number) => {
    void storage.put("files", fileId, { size, lastUsed: now() } satisfies CacheRow).catch(() => undefined);
  };

  const readCache = async (fileId: string): Promise<Blob | null> => {
    const cache = await openCache();
    if (cache === null) return null;
    try {
      const hit = await cache.match(cacheKey(fileId));
      if (hit === undefined) return null;
      const blob = await hit.blob();
      touch(fileId, blob.size);
      return blob;
    } catch (error) {
      console.warn("Reading the file cache failed", error);
      return null;
    }
  };

  /** Keeps the cache under its limit: the files shown least recently go first, never `keep`. */
  const evict = async (cache: Cache, keep: string) => {
    let rows: Array<{ key: string; value: CacheRow }>;
    try {
      rows = await storage.entries<CacheRow>("files");
    } catch {
      return;
    }
    let total = rows.reduce((sum, row) => sum + (Number(row.value?.size) || 0), 0);
    rows.sort((a, b) => (Number(a.value?.lastUsed) || 0) - (Number(b.value?.lastUsed) || 0));
    for (const row of rows) {
      if (total <= CACHE_LIMIT) break;
      if (row.key === keep) continue;
      try {
        await cache.delete(cacheKey(row.key));
        await storage.delete("files", row.key);
        total -= Number(row.value?.size) || 0;
      } catch {
        // The next write tries again.
      }
    }
  };

  const writeCache = async (fileId: string, blob: Blob) => {
    const cache = await openCache();
    if (cache === null) return;
    try {
      await cache.put(
        cacheKey(fileId),
        new Response(blob, { headers: { "Content-Type": blob.type || "application/octet-stream" } }),
      );
      await storage.put("files", fileId, { size: blob.size, lastUsed: now() } satisfies CacheRow);
      await evict(cache, fileId);
    } catch (error) {
      console.warn("Writing the file cache failed", error);
    }
  };

  // -- Download -------------------------------------------------------------

  const progress = (fileId: string, received: number, total: number, status: ChatFileLocal["status"], path: string | null) =>
    emit(CHAT_EVENTS.download, { fileId, received, total, path, status });

  async function fetchFile(fileId: string, mine: number): Promise<Blob> {
    const path = `/v1/chat/files/${segment(fileId)}/content`;
    const token = deps.token();
    if (token === null) throw signedOut();
    let response: Response;
    try {
      response = await fetchImpl(http.url(path), {
        headers: { Authorization: `Bearer ${token}` },
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    } catch (error) {
      throw networkError(`GET ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 401) deps.onUnauthorized();
      throw refusal(response.status, text, path);
    }
    const stated = Number(response.headers.get("content-length"));
    const total = Number.isFinite(stated) && stated > 0 ? stated : (known.get(fileId)?.size ?? 0);
    const type = response.headers.get("content-type") ?? known.get(fileId)?.mediaType ?? "";
    const chunks: Uint8Array[] = [];
    let received = 0;
    let last = 0;
    progress(fileId, 0, total, "downloading", null);
    const reader = response.body?.getReader();
    if (reader === undefined) {
      const whole = new Uint8Array(await response.arrayBuffer());
      chunks.push(whole);
      received = whole.length;
    } else {
      for (;;) {
        let step: ReadableStreamReadResult<Uint8Array>;
        try {
          step = await reader.read();
        } catch (error) {
          throw networkError(`the download stopped: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (step.done) break;
        chunks.push(step.value);
        received += step.value.length;
        if (received > MAX_FILE_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw networkError(`the file ${fileId} is larger than a chat file may be`);
        }
        if (mine === generation && now() - last >= PROGRESS_EVERY_MS) {
          last = now();
          progress(fileId, received, total, "downloading", null);
        }
      }
    }
    // Fewer bytes than the service stated: the answer was cut. More is not a
    // fault — a proxy that compressed the answer states its compressed size.
    if (Number.isFinite(stated) && stated > 0 && received < stated) {
      throw networkError(`the download of ${fileId} stopped at ${received} of ${stated} bytes`);
    }
    const blob = new Blob(chunks as BlobPart[], { type });
    const expected = hashes.get(fileId);
    if (expected !== undefined && (await sha256Hex(await blob.arrayBuffer())) !== expected) {
      throw networkError(`the download of ${fileId} does not match its hash`);
    }
    return blob;
  }

  /**
   * The bytes of a file: from memory, from the cache, or downloaded. A
   * second caller waits for the download the first one started. The end of
   * every download is told as `chat:download`.
   */
  function ensure(fileId: string): Promise<Blob> {
    const inMemory = shown.get(fileId);
    if (inMemory !== undefined) return Promise.resolve(inMemory.blob);
    const running = inflight.get(fileId);
    if (running !== undefined) return running;
    const mine = generation;
    const job = (async () => {
      try {
        const cached = await readCache(fileId);
        if (cached !== null) return cached;
        const blob = await fetchFile(fileId, mine);
        if (mine === generation) await writeCache(fileId, blob);
        return blob;
      } catch (error) {
        if (mine === generation) {
          const status: ChatFileLocal["status"] = isGone(error) ? "gone" : "remote";
          if (status === "gone") gone.add(fileId);
          else console.warn(`chat: cannot download ${fileId}`, error);
          progress(fileId, 0, 0, status, null);
        }
        throw error;
      }
    })();
    const tracked = job.then(
      (blob) => {
        if (inflight.get(fileId) === tracked) inflight.delete(fileId);
        if (mine === generation) {
          const url = urlFor(fileId, blob);
          progress(fileId, blob.size, blob.size, "cached", url);
        }
        return blob;
      },
      (error: unknown) => {
        if (inflight.get(fileId) === tracked) inflight.delete(fileId);
        throw error;
      },
    );
    inflight.set(fileId, tracked);
    return tracked;
  }

  // -- Staging --------------------------------------------------------------

  async function stageOne(file: File, origin: ChatWebFileOrigin): Promise<ChatStagedFile> {
    const name = sanitizeName(file.name || "file");
    if (file.size > MAX_FILE_BYTES) throw sizeRefusal(name, file.size);
    if (file.size === 0) throw invalidInput(`${name} is empty`);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      throw invalidInput(`${name} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (bytes.length > MAX_FILE_BYTES) throw sizeRefusal(name, bytes.length);
    if (bytes.length === 0) throw invalidInput(`${name} is empty`);
    // The session token is refused whatever the file is called.
    const secret = deps.token()?.trim() ?? "";
    if (secret.length >= 16 && containsText(bytes, secret)) {
      throw invalidInput(`${name} holds the JKNet session and is never sent`);
    }
    const clean = stripMetadata(bytes) ?? bytes;
    const classGuess = classify(name, clean);
    const blob = new Blob([clean as BlobPart], { type: file.type || "application/octet-stream" });
    let width: number | null = null;
    let height: number | null = null;
    if (classGuess === "image") {
      const measured = (await measure(blob)) ?? pictureSize(clean);
      const fits = (side: number) => Number.isInteger(side) && side >= 1 && side <= MAX_PICTURE_SIDE;
      if (measured !== null && fits(measured.width) && fits(measured.height)) {
        width = measured.width;
        height = measured.height;
      }
    }
    const sha256 = await sha256Hex(clean as BufferSource);
    const handle = newClientId(now());
    const meta: ChatFileMeta = { origin };
    if (width !== null && height !== null) {
      meta.width = width;
      meta.height = height;
    }
    staged.set(handle, { handle, name, size: clean.length, sha256, blob, meta, classGuess, origin });
    return { handle, name, size: clean.length, classGuess, width, height, origin };
  }

  // -- Upload ---------------------------------------------------------------

  async function putBytes(fileId: string, entry: Staged): Promise<void> {
    const path = `/v1/chat/files/${segment(fileId)}/content`;
    const token = deps.token();
    if (token === null) throw signedOut();
    let last = 0;
    const onProgress = (sent: number) => {
      if (sent < entry.size && now() - last < PROGRESS_EVERY_MS) return;
      last = now();
      emit(CHAT_EVENTS.upload, { handle: entry.handle, sent: Math.min(sent, entry.size), total: entry.size });
    };
    const answer = await put(http.url(path), token, entry.blob, onProgress);
    if (answer.status >= 200 && answer.status < 300) {
      emit(CHAT_EVENTS.upload, { handle: entry.handle, sent: entry.size, total: entry.size });
      return;
    }
    if (answer.status === 401) deps.onUnauthorized();
    throw answer.status === 0 ? networkError(`PUT ${path}: no answer`) : refusal(answer.status, answer.text, path);
  }

  const readRecord = (raw: unknown): Staged | null => {
    if (raw === null || typeof raw !== "object") return null;
    const record = raw as Partial<StagedRecord>;
    if (typeof record.handle !== "string" || typeof record.name !== "string" || typeof record.sha256 !== "string") return null;
    if (!(record.blob instanceof Blob) || typeof record.size !== "number") return null;
    const meta = record.meta !== null && typeof record.meta === "object" ? { ...record.meta } : {};
    const origin: ChatWebFileOrigin = meta.origin === "clipboard" ? "clipboard" : "file";
    return {
      handle: record.handle,
      name: record.name,
      size: record.size,
      sha256: record.sha256,
      blob: record.blob,
      meta,
      classGuess: record.classGuess ?? "other",
      origin,
    };
  };

  return {
    async upload(conversationId, handle) {
      const entry = staged.get(handle);
      if (entry === undefined) throw invalidInput(`the attachment ${handle} is no longer staged`);
      uploading += 1;
      try {
        const answer = await http.request<{ file?: ChatFileRef; needsUpload?: unknown }>("POST", "/v1/chat/files", {
          body: { conversationId, name: entry.name, size: entry.size, sha256: entry.sha256, meta: entry.meta },
        });
        const fileId = fileIdOf(answer?.file?.id);
        if (answer.file !== undefined) known.set(fileId, answer.file);
        if (answer?.needsUpload !== false) await putBytes(fileId, entry);
        hashes.set(fileId, entry.sha256);
        return fileId;
      } finally {
        uploading -= 1;
      }
    },

    settleSent(uploaded) {
      for (const [handle, fileId] of uploaded) {
        const sha256 = staged.get(handle)?.sha256;
        if (sha256 !== undefined) hashes.set(fileId, sha256);
        // Another queued message still carries it: it stays staged.
        if (deps.held(handle)) continue;
        const entry = staged.get(handle);
        if (entry === undefined) continue;
        staged.delete(handle);
        // The sender's own copy is the cached copy: it never comes back down.
        urlFor(fileId, entry.blob);
        void writeCache(fileId, entry.blob);
      }
    },

    drop(handles) {
      for (const handle of handles) {
        if (!deps.held(handle)) staged.delete(handle);
      }
    },

    records(handles) {
      return handles.flatMap((handle) => {
        const entry = staged.get(handle);
        if (entry === undefined) return [];
        const { name, size, sha256, blob, meta, classGuess } = entry;
        return [{ handle, name, size, sha256, blob, meta: { ...meta }, classGuess }];
      });
    },

    restore(records) {
      for (const raw of Array.isArray(records) ? records : []) {
        const entry = readRecord(raw);
        if (entry !== null && !staged.has(entry.handle)) staged.set(entry.handle, entry);
      }
    },

    async stage(files, origin) {
      const list: File[] = Array.isArray(files) ? files.filter((file): file is File => file instanceof Blob) : [];
      const from: ChatWebFileOrigin = origin === "clipboard" ? "clipboard" : "file";
      const done: ChatStagedFile[] = [];
      const refused: ChatStageRefusal[] = [];
      for (const [index, file] of list.entries()) {
        const name = typeof file.name === "string" && file.name !== "" ? file.name : "file";
        if (index >= MAX_ATTACHMENTS) {
          refused.push({ name, error: envelopeOf(invalidInput(`a message carries at most ${MAX_ATTACHMENTS} files`)) });
          continue;
        }
        try {
          done.push(await stageOne(file, from));
        } catch (error) {
          console.info(`chat: the file ${name} was not staged`, error);
          refused.push({ name, error: envelopeOf(error) });
        }
      }
      const event: ChatFilesStagedEvent = { files: done, refused };
      emit(CHAT_EVENTS.filesStaged, event);
      return event;
    },

    unstage(handle) {
      if (!deps.held(handle)) staged.delete(handle);
    },

    async local(fileId, wanted) {
      const id = fileIdOf(fileId);
      const inMemory = shown.get(id);
      if (inMemory !== undefined) return { status: "cached", path: urlFor(id, inMemory.blob) };
      if (gone.has(id)) return { status: "gone", path: null };
      if (inflight.has(id)) return { status: "downloading", path: null };
      const cached = await readCache(id);
      if (cached !== null) return { status: "cached", path: urlFor(id, cached) };
      // The sender's own copy may have settled, or a download started,
      // while the cache was read: an answer `downloading` must always be
      // followed by the event that ends it.
      const settled = shown.get(id);
      if (settled !== undefined) return { status: "cached", path: urlFor(id, settled.blob) };
      if (inflight.has(id)) return { status: "downloading", path: null };
      if (!wanted) return { status: "remote", path: null };
      if (deps.token() === null) throw signedOut();
      void ensure(id).catch(() => undefined);
      return { status: "downloading", path: null };
    },

    async save(fileId, confirmed) {
      const id = fileIdOf(fileId);
      const blob = await ensure(id);
      const ref = known.get(id);
      const name = sanitizeName(ref?.name ?? "file");
      const head = new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer());
      const reasons = dangerReasons(name, head, ref?.danger === true || ref?.class === "executable");
      if (reasons.length > 0 && !confirmed) throw onlineError(CONFIRM_DANGER, reasons.join("; "));
      download(urlFor(id, blob), name);
      return name;
    },

    remember(messages) {
      for (const message of messages) {
        for (const file of message?.files ?? []) {
          if (typeof file?.id !== "string" || file.id === "") continue;
          if (known.size >= KNOWN_LIMIT && !known.has(file.id)) known.clear();
          known.set(file.id, file);
        }
      }
    },

    busy: () => staged.size > 0 || uploading > 0,

    forget() {
      generation += 1;
      staged.clear();
      known.clear();
      hashes.clear();
      gone.clear();
      inflight.clear();
      for (const { url } of shown.values()) revokeUrl(url);
      shown.clear();
    },
  };
}
