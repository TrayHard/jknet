/**
 * What a picture records about its taking, removed before it leaves the
 * device: the port of `strip_metadata` and `picture_size` of the launcher's
 * `src-tauri/src/chat/files.rs`, byte for byte the same rules.
 *
 * A JPEG loses `APP1` (Exif, with GPS and the camera; XMP), `APP13`
 * (Photoshop, IPTC), comments, the `MPF` index of the pictures stored after
 * the first one, and whatever follows its end — which is where those
 * pictures, with their own Exif, are. The one thing kept of Exif is the
 * orientation, rewritten as a block of its own, so a photo taken upright
 * does not arrive on its side. A PNG loses `eXIf`, `tEXt`, `iTXt`, `zTXt`
 * and whatever follows `IEND`. A structure that breaks is cut where it
 * breaks: nothing after it can be read to be checked.
 *
 * Everything here is pure: bytes in, bytes out, no DOM.
 */

/** What the service accepts as the width or the height of a picture. */
export const MAX_PICTURE_SIDE = 16_384;

export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

export type PictureType = "png" | "jpeg" | "gif" | "webp";

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

/** `png`, `jpeg`, `gif` or `webp`, by the signature. */
export function pictureType(head: Uint8Array): PictureType | null {
  if (startsWith(head, PNG_SIGNATURE)) return "png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(head, ascii("GIF87a")) || startsWith(head, ascii("GIF89a"))) return "gif";
  if (startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8)) return "webp";
  return null;
}

/** Collects bytes without copying each piece twice. */
class Sink {
  private readonly parts: Uint8Array[] = [];
  private length = 0;

  push(part: ArrayLike<number> | Uint8Array): void {
    const bytes = part instanceof Uint8Array ? part : Uint8Array.from(part);
    if (bytes.length === 0) return;
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/**
 * The picture without what it records about its taking, or `null` when the
 * bytes are not a JPEG or a PNG.
 */
export function stripMetadata(bytes: Uint8Array): Uint8Array | null {
  switch (pictureType(bytes)) {
    case "jpeg":
      return stripJpeg(bytes);
    case "png":
      return stripPng(bytes);
    default:
      return null;
  }
}

export function stripJpeg(bytes: Uint8Array): Uint8Array {
  const out = new Sink();
  out.push(bytes.subarray(0, 2));
  let pos = 2;
  let orientationKept = false;
  while (pos < bytes.length) {
    // What sits between segments and is not a marker is junk a decoder
    // skips as well.
    if (bytes[pos] !== 0xff) {
      pos += 1;
      continue;
    }
    while (pos < bytes.length && bytes[pos] === 0xff) pos += 1;
    if (pos >= bytes.length) break;
    const marker = bytes[pos];
    pos += 1;
    if (marker === 0xd9) {
      out.push([0xff, 0xd9]);
      break;
    }
    if (marker === 0x00) continue;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push([0xff, marker]);
      continue;
    }
    if (pos + 2 > bytes.length) break;
    const length = (bytes[pos] << 8) | bytes[pos + 1];
    if (length < 2 || pos + length > bytes.length) break;
    const segment = bytes.subarray(pos, pos + length);
    pos += length;
    const payload = segment.subarray(2);
    if (dropsSegment(marker, payload)) {
      if (marker === 0xe1 && !orientationKept) {
        const orientation = exifOrientation(payload);
        if (orientation !== null) {
          out.push(orientationSegment(orientation));
          orientationKept = true;
        }
      }
    } else {
      out.push([0xff, marker]);
      out.push(segment);
    }
    if (marker === 0xda) {
      const start = pos;
      pos = scanEnd(bytes, pos);
      out.push(bytes.subarray(start, pos));
    }
  }
  return out.bytes();
}

/**
 * The end of the entropy-coded data of a scan: the next marker that is not
 * a stuffed byte, a restart or padding.
 */
function scanEnd(bytes: Uint8Array, from: number): number {
  let pos = from;
  while (pos < bytes.length) {
    if (bytes[pos] === 0xff && pos + 1 < bytes.length) {
      const next = bytes[pos + 1];
      if (!(next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff)) break;
    }
    pos += 1;
  }
  return pos;
}

/** The JPEG segments that record where, when and with what a picture was taken. */
function dropsSegment(marker: number, payload: Uint8Array): boolean {
  if (marker === 0xe1 || marker === 0xed || marker === 0xfe) return true;
  if (marker === 0xe2) return startsWith(payload, [0x4d, 0x50, 0x46, 0x00]); // "MPF\0"
  return false;
}

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

/** The orientation of an Exif block, when it turns the picture. */
export function exifOrientation(payload: Uint8Array): number | null {
  if (!startsWith(payload, EXIF_HEADER)) return null;
  const tiff = payload.subarray(EXIF_HEADER.length);
  let big: boolean;
  if (startsWith(tiff, [0x4d, 0x4d, 0x00, 0x2a])) big = true;
  else if (startsWith(tiff, [0x49, 0x49, 0x2a, 0x00])) big = false;
  else return null;
  const u16At = (at: number): number | null => {
    if (at < 0 || at + 2 > tiff.length) return null;
    return big ? (tiff[at] << 8) | tiff[at + 1] : tiff[at] | (tiff[at + 1] << 8);
  };
  const u32At = (at: number): number | null => {
    if (at < 0 || at + 4 > tiff.length) return null;
    const [a, b, c, d] = [tiff[at], tiff[at + 1], tiff[at + 2], tiff[at + 3]];
    return big ? ((a << 24) | (b << 16) | (c << 8) | d) >>> 0 : ((d << 24) | (c << 16) | (b << 8) | a) >>> 0;
  };
  const ifd = u32At(4);
  if (ifd === null) return null;
  const count = u16At(ifd);
  if (count === null) return null;
  for (let index = 0; index < Math.min(count, 512); index += 1) {
    const entry = ifd + 2 + index * 12;
    const tag = u16At(entry);
    if (tag === null) return null;
    if (tag !== 0x0112) continue;
    const value = u16At(entry + 8);
    return value !== null && value >= 2 && value <= 8 ? value : null;
  }
  return null;
}

/** An `APP1` Exif block that records an orientation and nothing else. */
export function orientationSegment(orientation: number): Uint8Array {
  // Big-endian TIFF, IFD0 right after the header, one entry: Orientation,
  // SHORT, one value, padded to four bytes; no next IFD.
  const payload = [
    ...EXIF_HEADER,
    0x4d, 0x4d, 0x00, 0x2a,
    0x00, 0x00, 0x00, 0x08,
    0x00, 0x01,
    0x01, 0x12,
    0x00, 0x03,
    0x00, 0x00, 0x00, 0x01,
    (orientation >> 8) & 0xff, orientation & 0xff,
    0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ];
  const length = payload.length + 2;
  return Uint8Array.from([0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...payload]);
}

const PNG_DROPPED = new Set(["eXIf", "tEXt", "iTXt", "zTXt"]);

export function stripPng(bytes: Uint8Array): Uint8Array {
  const out = new Sink();
  out.push(PNG_SIGNATURE);
  let pos = PNG_SIGNATURE.length;
  while (pos + 8 <= bytes.length) {
    const length = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
    const kind = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const end = pos + 12 + length;
    if (end > bytes.length) break;
    const chunk = bytes.subarray(pos, end);
    pos = end;
    if (!PNG_DROPPED.has(kind)) out.push(chunk);
    if (kind === "IEND") break;
  }
  return out.bytes();
}

/**
 * The width and height of a PNG, JPEG, GIF or WebP picture, when both are
 * what the service accepts.
 */
export function pictureSize(bytes: Uint8Array): { width: number; height: number } | null {
  const be32 = (at: number): number | null =>
    at + 4 > bytes.length ? null : ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  const le16 = (at: number): number | null => (at + 2 > bytes.length ? null : bytes[at] | (bytes[at + 1] << 8));
  let size: [number, number] | null = null;
  switch (pictureType(bytes)) {
    case "png": {
      if (!startsWith(bytes, ascii("IHDR"), 12)) return null;
      const [width, height] = [be32(16), be32(20)];
      size = width === null || height === null ? null : [width, height];
      break;
    }
    case "gif": {
      const [width, height] = [le16(6), le16(8)];
      size = width === null || height === null ? null : [width, height];
      break;
    }
    case "jpeg":
      size = jpegSize(bytes);
      break;
    case "webp":
      size = webpSize(bytes);
      break;
    default:
      return null;
  }
  if (size === null) return null;
  const fits = (side: number) => side >= 1 && side <= MAX_PICTURE_SIDE;
  return fits(size[0]) && fits(size[1]) ? { width: size[0], height: size[1] } : null;
}

/** The size a JPEG's start-of-frame declares. */
function jpegSize(bytes: Uint8Array): [number, number] | null {
  let pos = 2;
  for (;;) {
    while (pos < bytes.length && bytes[pos] !== 0xff) pos += 1;
    while (pos < bytes.length && bytes[pos] === 0xff) pos += 1;
    if (pos >= bytes.length) return null;
    const marker = bytes[pos];
    pos += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (pos + 2 > bytes.length) return null;
    const length = (bytes[pos] << 8) | bytes[pos + 1];
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (pos + 7 > bytes.length) return null;
      const height = (bytes[pos + 3] << 8) | bytes[pos + 4];
      const width = (bytes[pos + 5] << 8) | bytes[pos + 6];
      return [width, height];
    }
    pos += length;
  }
}

/** The canvas of a WebP picture: lossy, lossless or extended. */
function webpSize(bytes: Uint8Array): [number, number] | null {
  const le24 = (at: number): number | null =>
    at + 3 > bytes.length ? null : bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
  if (bytes.length < 16) return null;
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunk === "VP8 ") {
    if (bytes.length < 30) return null;
    const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
    const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
    return [width, height];
  }
  if (chunk === "VP8L") {
    if (bytes.length < 25) return null;
    const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  if (chunk === "VP8X") {
    const [width, height] = [le24(24), le24(27)];
    return width === null || height === null ? null : [width + 1, height + 1];
  }
  return null;
}
