/**
 * What the service would refuse, said before the request: the rules of
 * `community/mod.rs` and `community/pages.rs` of JKNet Online, field by
 * field, so the screen names the field in the organizer's language instead
 * of printing the service's English sentence after a round trip.
 *
 * Only a changed field is checked. The service lets a stored value through
 * as it is — the name of a page from before communities, a Discord link
 * that is not an invite — and so does the screen.
 *
 * Pure: the tests run this file in Node.
 */

import { isCommunityId } from "../api.ts";
import { jkhubId } from "../types.ts";
import { changed, normalizeInvite, type ManageDraft } from "./model.ts";

/** The limits of the contract. */
export const LIMITS = {
  name: 100,
  tagline: 140,
  description: 6000,
  rules: 4000,
  /** Characters of one link. */
  link: 500,
  links: 8,
  files: 30,
  fileTitle: 120,
  label: 40,
  tags: 8,
  languages: 5,
  servers: 10,
  editors: 20,
} as const;

/** What is wrong with a field, as the screen names it. */
export type Problem =
  | "required"
  | "tooLong"
  | "oneLine"
  | "control"
  | "https"
  | "invite"
  | "linkHost"
  | "linkEmpty"
  | "fileTitle"
  | "fileLink"
  | "fileDuplicate"
  | "bundle";

export interface DraftProblems {
  name?: Problem;
  tagline?: Problem;
  description?: Problem;
  rules?: Problem;
  website?: Problem;
  discord?: Problem;
  /** By the key of the row. */
  links: Record<number, Problem>;
  /** By the key of the row. */
  files: Record<number, Problem>;
  /** By the id of the server. */
  labels: Record<string, Problem>;
  bundle?: Problem;
}

/** Characters as the service counts them: code points, not UTF-16 units. */
export function chars(value: string): number {
  return Array.from(value).length;
}

/** Control characters the service refuses anywhere; a line break and a tab only in the long texts. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const BREAK = /[\n\t]/;

function text(value: string, max: number, required: boolean, oneLine: boolean): Problem | undefined {
  const trimmed = value.trim();
  if (required && trimmed === "") return "required";
  if (chars(trimmed) > max) return "tooLong";
  if (oneLine && (CONTROL.test(trimmed) || BREAK.test(trimmed))) return "oneLine";
  if (CONTROL.test(trimmed)) return "control";
  return undefined;
}

/** An `https:` address with a host and without credentials, as `link` of the service takes it. */
export function httpsHost(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname === "" || url.username !== "" || url.password !== "") return null;
    return url.hostname;
  } catch {
    return null;
  }
}

/** The hosts a link of a kind may lead to; `null` for `other`, which takes any. */
export const LINK_HOSTS: Record<string, readonly string[] | null> = {
  youtube: ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"],
  twitch: ["twitch.tv", "www.twitch.tv"],
  telegram: ["t.me", "telegram.me"],
  vk: ["vk.com", "vk.ru", "m.vk.com"],
  steam: ["steamcommunity.com", "store.steampowered.com"],
  github: ["github.com"],
  other: null,
};

/** The kinds of link, in the order the select lists them. */
export const LINK_KINDS = ["youtube", "twitch", "telegram", "vk", "steam", "github", "other"] as const;

/** What is wrong with one link, or nothing. */
export function linkProblem(kind: string, url: string): Problem | undefined {
  const trimmed = url.trim();
  if (trimmed === "") return "linkEmpty";
  if (chars(trimmed) > LIMITS.link) return "tooLong";
  if (BREAK.test(trimmed) || CONTROL.test(trimmed)) return "oneLine";
  const host = httpsHost(trimmed);
  if (host === null) return "https";
  const hosts = LINK_HOSTS[kind];
  if (hosts === undefined) return "linkHost";
  if (hosts !== null && !hosts.includes(host)) return "linkHost";
  return undefined;
}

/**
 * The code of a Discord invite, as `invite_code` of the service reads it:
 * `https://discord.gg/CODE`, `https://discord.com/invite/CODE` or the same on
 * `www.discord.com`, the code 2 to 32 letters, digits and hyphens, nothing
 * after it. `null` for anything else.
 */
export function inviteCode(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
  let code: string;
  if (url.hostname === "discord.gg") code = url.pathname.slice(1);
  else if (url.hostname === "discord.com" || url.hostname === "www.discord.com") {
    if (!url.pathname.startsWith("/invite/")) return null;
    code = url.pathname.slice("/invite/".length);
  } else return null;
  return /^[A-Za-z0-9-]{2,32}$/.test(code) ? code : null;
}

/** The problems of the changed fields of the form. */
export function problemsOf(base: ManageDraft, draft: ManageDraft): DraftProblems {
  const problems: DraftProblems = { links: {}, files: {}, labels: {} };
  if (changed(base, draft, "name")) problems.name = text(draft.name, LIMITS.name, true, true);
  if (changed(base, draft, "tagline")) problems.tagline = text(draft.tagline, LIMITS.tagline, false, true);
  if (changed(base, draft, "description")) problems.description = text(draft.description, LIMITS.description, false, false);
  if (changed(base, draft, "rules")) problems.rules = text(draft.rules, LIMITS.rules, false, false);
  if (changed(base, draft, "website") && draft.website.trim() !== "") {
    problems.website = text(draft.website, LIMITS.link, false, true) ?? (httpsHost(draft.website) === null ? "https" : undefined);
  }
  if (changed(base, draft, "discord") && draft.discord.trim() !== "") {
    const invite = normalizeInvite(draft.discord);
    problems.discord = text(invite, LIMITS.link, false, true) ?? (inviteCode(invite) === null ? "invite" : undefined);
  }
  if (changed(base, draft, "links")) {
    for (const link of draft.links) {
      const problem = linkProblem(link.kind, link.url);
      if (problem) problems.links[link.key] = problem;
    }
  }
  if (changed(base, draft, "files")) {
    const seen = new Set<number>();
    for (const file of draft.files) {
      const title = file.title.trim();
      const id = jkhubId(file.link);
      let problem: Problem | undefined;
      if (title === "") problem = "fileTitle";
      else if (chars(title) > LIMITS.fileTitle) problem = "tooLong";
      else if (CONTROL.test(title)) problem = "control";
      else if (id === null) problem = "fileLink";
      else if (seen.has(id)) problem = "fileDuplicate";
      if (id !== null) seen.add(id);
      if (problem) problems.files[file.key] = problem;
    }
  }
  for (const [serverId, label] of Object.entries(draft.labels)) {
    const before = base.labels[serverId];
    if (before === undefined || label.trim() === before.trim()) continue;
    const problem = text(label, LIMITS.label, false, true);
    if (problem) problems.labels[serverId] = problem;
  }
  if (changed(base, draft, "bundleId") && draft.bundleId !== null && !isCommunityId(draft.bundleId)) problems.bundle = "bundle";
  return problems;
}

/** Whether anything stops the save. */
export function hasProblems(problems: DraftProblems): boolean {
  return (
    [problems.name, problems.tagline, problems.description, problems.rules, problems.website, problems.discord, problems.bundle].some(
      (problem) => problem !== undefined,
    ) ||
    Object.keys(problems.links).length > 0 ||
    Object.keys(problems.files).length > 0 ||
    Object.keys(problems.labels).length > 0
  );
}

/** What is wrong with the address of a server to add. */
export type AddressProblem = "shape" | "port" | "private";

/**
 * The address of a game server as `public_address` of the service takes it:
 * `IPv4:port`, a port from 1024, and an address the internet routes to.
 */
export function addressProblem(value: string): AddressProblem | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(value.trim());
  if (match === null) return "shape";
  const [a, b, c, d] = match.slice(1, 5).map(Number);
  if ([a, b, c, d].some((octet) => octet > 255)) return "shape";
  const port = Number(match[5]);
  if (port > 65535) return "shape";
  if (port < 1024) return "port";
  const reserved =
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
  return reserved ? "private" : null;
}

/**
 * The id of a bundle out of what the organizer pasted: the id itself, or a
 * link whose last part is one. `null` for anything else.
 */
export function bundleIdOf(value: string): string | null {
  const trimmed = value.trim();
  if (isCommunityId(trimmed)) return trimmed;
  try {
    const parts = new URL(trimmed).pathname.split("/").filter((part) => part !== "");
    const last = parts[parts.length - 1];
    return isCommunityId(last) ? last : null;
  } catch {
    return null;
  }
}

/** A JKNet Online account id: a ULID, as the routes of editors and owners take it. */
export function accountIdOf(value: string): string | null {
  const trimmed = value.trim();
  return isCommunityId(trimmed) ? trimmed : null;
}
