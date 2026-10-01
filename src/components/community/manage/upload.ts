/**
 * A logo or a cover from a file input: the website's way to the store of
 * JKNet Online. The launcher does the same in its core, behind its own
 * dialog (`community_pick_image`).
 *
 * The checks are the service's (`PUT communities/{id}/images`): PNG, JPEG
 * or WebP by the first bytes of the file, a logo up to 1 MiB and a cover up
 * to 3 MiB. A file that fails them is refused before a byte is sent; one
 * that passes is hashed with SHA-256 and handed to the host's `putBlob`,
 * which answers `PUT /v1/blobs/{sha256}`.
 *
 * Pure but for `crypto.subtle`, which Node has as well: the tests run it.
 */

import type { CommunityImageKind, ImageRefusal, UploadedImage } from "../platform.tsx";

const MIB = 1024 * 1024;

/** The largest picture of each kind, in bytes. */
export const IMAGE_MAX_BYTES: Record<CommunityImageKind, number> = {
  logo: MIB,
  banner: 3 * MIB,
};

/** What a file input offers: the three types the service takes. */
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";

/** The type the first bytes of a file announce, among the three the service takes. */
export function sniffImage(head: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  const starts = (bytes: number[], at = 0) => bytes.every((byte, index) => head[at + index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  // `RIFF`, four bytes of size, `WEBP`.
  if (head.length >= 12 && starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

/** Lowercase hex SHA-256 of the bytes, as the store names a file. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A picture the checks let through: its bytes, their hash and the type they announce. */
export interface PreparedImage {
  bytes: ArrayBuffer;
  sha256: string;
  size: number;
  type: string;
}

/** Checks a picked file the way the service will, and hashes it. */
export async function prepareImage(
  file: Blob & { name?: string },
  kind: CommunityImageKind,
): Promise<{ refused: ImageRefusal } | { image: PreparedImage }> {
  const fileName = file.name ?? "";
  const maxBytes = IMAGE_MAX_BYTES[kind];
  if (file.size > maxBytes) return { refused: { reason: "tooBig", fileName, maxBytes } };
  const bytes = await file.arrayBuffer();
  const type = sniffImage(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 16)));
  if (type === null) return { refused: { reason: "notPicture", fileName } };
  return { image: { bytes, sha256: await sha256Hex(bytes), size: bytes.byteLength, type } };
}

/** The width and the height of a picture, when the browser can decode it. */
export async function pictureSize(blob: Blob): Promise<{ width: number; height: number } | null> {
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

/**
 * Checks, hashes and uploads a picked file through `putBlob`. A refusal
 * comes back as a value; a failure of the upload is thrown.
 */
export async function uploadImageFile(
  file: Blob & { name?: string },
  kind: CommunityImageKind,
  putBlob: (sha256: string, file: Blob) => Promise<void>,
): Promise<{ refused: ImageRefusal } | { uploaded: UploadedImage }> {
  const prepared = await prepareImage(file, kind);
  if ("refused" in prepared) return prepared;
  const { image } = prepared;
  const blob = new Blob([image.bytes], { type: image.type });
  await putBlob(image.sha256, blob);
  const size = await pictureSize(blob);
  return {
    uploaded: {
      sha256: image.sha256,
      size: image.size,
      fileName: file.name ?? "",
      width: size?.width ?? null,
      height: size?.height ?? null,
    },
  };
}
