/**
 * Whether the catalogue of JKNet Online lists a community, and why not, read
 * off its card: the condition `IN_CATALOG` of the service
 * (`community/store.rs`) as far as a card shows it.
 *
 * The service lists a community while both hold:
 *
 * 1. it has an owner, or an administrator listed it without one (`listed`);
 * 2. it shows a server to everyone: a verified server, or, while it has no
 *    owner, the server it was founded with (`Loaded::is_public`). The
 *    founding server shares the id of its community.
 *
 * A page an administrator creates starts with its server verified and with
 * no owner, so it stays out by the first rule until it is listed.
 *
 * Every card holds the servers everyone sees — the catalogue's, a page's,
 * and the organizers' of `GET me`, which add the servers not verified yet —
 * so for the card as it was read the answer is the service's. What a card
 * cannot tell:
 *
 * - what changed after it was read: a server verified, moved or removed, an
 *   owner appointed or removed, a listing changed on another screen;
 * - the listing on a card of a service from before it, which has no
 *   `listed`: it reads as not listed;
 * - why a screen leaves out a community the catalogue lists: the launcher's
 *   catalogue shows the game of its switch only, the search, the tags, the
 *   language and the region narrow it further, and it comes in pages.
 *
 * Pure, so `catalogVisibility.test.mjs` checks it under `node --test`.
 */

import type { CommunityServer } from "./types";

/** A rule of the catalogue that a community misses. */
export type CatalogGap =
  /** No owner, and no administrator listed it. */
  | "unlisted"
  /** No server everyone can see. */
  | "noPublicServer";

/** The fields of a card the rule reads. */
export interface CatalogFacts {
  id: string;
  ownerId: string | null;
  /** Absent on a card of a service from before the listing: not listed. */
  listed?: boolean;
  servers: readonly Pick<CommunityServer, "id" | "verified">[];
}

/** Where a community stands with the catalogue. */
export interface CatalogVisibility {
  inCatalog: boolean;
  /** The rules it misses, in the order of the rule; empty while it is in. */
  gaps: CatalogGap[];
  /** No owner and not listed: an administrator's listing lifts `unlisted`. */
  publishable: boolean;
}

function owned(card: Pick<CatalogFacts, "ownerId">): boolean {
  return typeof card.ownerId === "string" && card.ownerId !== "";
}

/**
 * Whether everyone sees `server` of `card`: a verified server, or the
 * founding server of a community without an owner.
 */
export function isPublicServer(card: Pick<CatalogFacts, "id" | "ownerId">, server: Pick<CommunityServer, "id" | "verified">): boolean {
  return server.verified === true || (!owned(card) && server.id === card.id);
}

/** Where `card` stands with the catalogue, and the rules it misses. */
export function catalogVisibility(card: CatalogFacts): CatalogVisibility {
  const unlisted = !owned(card) && card.listed !== true;
  const gaps: CatalogGap[] = [];
  if (unlisted) gaps.push("unlisted");
  if (!card.servers.some((server) => isPublicServer(card, server))) gaps.push("noPublicServer");
  return { inCatalog: gaps.length === 0, gaps, publishable: unlisted };
}

/** Whether the catalogue lists `card`. */
export function inCatalog(card: CatalogFacts): boolean {
  return catalogVisibility(card).inCatalog;
}

/** What the reader of a row can do about a community out of the catalogue. */
export type CatalogRemedy =
  /** List it from the row: an administrator, on a host that manages. */
  | "publish"
  /** Confirm the server and become its owner: an owner needs no listing. */
  | "claim"
  /** Confirm a server, which everyone sees then. */
  | "verify";

/**
 * The way into the catalogue a row of **My communities** offers its reader,
 * or `null` when there is none to offer: the community is in, or the reader
 * is an administrator on a host that does not manage, such as the web app.
 */
export function catalogRemedy(visibility: CatalogVisibility, reader: { admin: boolean; canManage: boolean }): CatalogRemedy | null {
  if (visibility.inCatalog) return null;
  if (visibility.gaps.includes("unlisted")) {
    if (!reader.admin) return "claim";
    return reader.canManage ? "publish" : null;
  }
  return "verify";
}
