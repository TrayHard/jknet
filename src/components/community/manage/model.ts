/**
 * The form of the management screen as data: what the organizers typed,
 * against the page it was read from.
 *
 * The profile, the links, the tags, the recommended files, the bundle, the
 * pictures and the labels of the servers wait for **Save changes**; adding,
 * moving, verifying and removing a server, the editors and the administrator's
 * switches apply at once through their own routes. Every write of either kind
 * moves the page's `revision` by one, so the form keeps the revision its edits
 * were made on: a page that moved by one write of this screen is rebased under
 * the edits, and a page that moved by more — somebody else saved meanwhile —
 * keeps the old revision, which the service answers with `409`.
 *
 * Pure: the screen holds a {@link FormState} in a reducer, and the tests run
 * this file in Node.
 */

import type { CommunityPatch } from "../api.ts";
import { jkhubId, type Community } from "../types.ts";

/** A link of the form: a stable key for the list, the kind and the address as typed. */
export interface LinkRow {
  key: number;
  kind: string;
  url: string;
}

/** A recommended file of the form: the title and the JKHub link or id as typed. */
export interface FileRow {
  key: number;
  title: string;
  link: string;
}

/** Everything the save bar sends. */
export interface ManageDraft {
  name: string;
  tagline: string;
  description: string;
  rules: string;
  website: string;
  discord: string;
  links: LinkRow[];
  tags: string[];
  languages: string[];
  region: string | null;
  files: FileRow[];
  bundleId: string | null;
  /** The name of the chosen bundle, when the screen knows it: not a field of its own. */
  bundleName: string | null;
  /** SHA-256 of the logo in the store of the service. */
  logo: string | null;
  /** SHA-256 of the cover. */
  banner: string | null;
  /** The label of each server, by its id. */
  labels: Record<string, string>;
}

/** The fields `PUT communities/{id}` takes, as the form names them. */
export const PAGE_FIELDS = [
  "name",
  "tagline",
  "description",
  "rules",
  "website",
  "discord",
  "links",
  "tags",
  "languages",
  "region",
  "files",
  "bundleId",
] as const;

/** The fields `PUT communities/{id}/images` takes. */
export const IMAGE_FIELDS = ["logo", "banner"] as const;

export type PageField = (typeof PAGE_FIELDS)[number];
export type ImageField = (typeof IMAGE_FIELDS)[number];
export type DraftField = PageField | ImageField;

let lastKey = 0;

/** A key no row of this page has had. */
export function rowKey(): number {
  lastKey += 1;
  return lastKey;
}

/** The page of a file on JKHub: how the form writes a recommendation it read. */
export function jkhubLink(id: number): string {
  return `https://jkhub.org/files/file/${id}/`;
}

/** The form of a page as the service gave it. */
export function draftOf(community: Community): ManageDraft {
  return {
    name: community.name,
    tagline: community.tagline,
    description: community.description,
    rules: community.rules,
    website: community.website,
    discord: community.discord,
    links: community.links.map((link) => ({ key: rowKey(), kind: link.kind, url: link.url })),
    tags: [...community.tags],
    languages: [...community.languages],
    region: community.region,
    files: community.recommendations.map((file) => ({ key: rowKey(), title: file.title, link: jkhubLink(file.jkhubId) })),
    bundleId: community.bundle?.id ?? null,
    bundleName: community.bundle?.name ?? null,
    logo: community.logo,
    banner: community.banner,
    labels: Object.fromEntries(community.servers.map((server) => [server.id, server.label])),
  };
}

/**
 * A Discord invite as the service takes it: `discord.gg/CODE` typed without
 * the scheme gets `https://`, and the slash after the code goes. Anything
 * else is left as typed, for the check to name.
 */
export function normalizeInvite(value: string): string {
  let invite = value.trim();
  if (/^(www\.)?(discord\.gg|discord\.com)\//i.test(invite)) invite = `https://${invite}`;
  if (/^https:\/\/(www\.)?(discord\.gg|discord\.com)\/.+\/$/i.test(invite)) invite = invite.slice(0, -1);
  return invite;
}

/** What two values of a field are compared by: what the service would store. */
function shape(field: DraftField, draft: ManageDraft): string {
  switch (field) {
    case "name":
    case "tagline":
    case "website":
    case "description":
    case "rules":
      return draft[field].trim();
    case "discord":
      return normalizeInvite(draft.discord);
    case "links":
      return JSON.stringify(draft.links.map((link) => [link.kind, link.url.trim()]));
    case "tags":
    case "languages":
      return JSON.stringify(draft[field]);
    case "region":
      return draft.region ?? "";
    case "files":
      return JSON.stringify(draft.files.map((file) => [file.title.trim(), jkhubId(file.link) ?? file.link.trim()]));
    case "bundleId":
      return draft.bundleId ?? "";
    case "logo":
    case "banner":
      return draft[field] ?? "";
  }
}

/** Whether a field of `draft` says something else than the same field of `base`. */
export function changed(base: ManageDraft, draft: ManageDraft, field: DraftField): boolean {
  return shape(field, base) !== shape(field, draft);
}

/** The servers whose label the form changed, with the label to send. */
export function labelChanges(base: ManageDraft, draft: ManageDraft): { serverId: string; label: string }[] {
  return Object.keys(base.labels)
    .filter((serverId) => serverId in draft.labels && draft.labels[serverId].trim() !== base.labels[serverId].trim())
    .map((serverId) => ({ serverId, label: draft.labels[serverId].trim() }));
}

/** The fields the form changed, in the order of the screen. */
export function dirtyFields(base: ManageDraft, draft: ManageDraft): DraftField[] {
  return [...PAGE_FIELDS, ...IMAGE_FIELDS].filter((field) => changed(base, draft, field));
}

/** Whether the save bar has anything to save. */
export function isDirty(base: ManageDraft, draft: ManageDraft): boolean {
  return dirtyFields(base, draft).length > 0 || labelChanges(base, draft).length > 0;
}

/**
 * The body of `PUT communities/{id}`: the changed fields only, on the
 * revision the edits were made on, or `null` when no field of the page
 * changed. A field left out keeps what the page has; `null` clears.
 */
export function pagePatch(base: ManageDraft, draft: ManageDraft, revision: number): CommunityPatch | null {
  const patch: CommunityPatch = { revision };
  let any = false;
  const put = <K extends keyof CommunityPatch>(key: K, value: CommunityPatch[K]) => {
    patch[key] = value;
    any = true;
  };
  if (changed(base, draft, "name")) put("name", draft.name.trim());
  if (changed(base, draft, "tagline")) put("tagline", draft.tagline.trim());
  if (changed(base, draft, "description")) put("description", draft.description.trim());
  if (changed(base, draft, "rules")) put("rules", draft.rules.trim());
  if (changed(base, draft, "website")) put("website", draft.website.trim());
  if (changed(base, draft, "discord")) put("discord", normalizeInvite(draft.discord));
  if (changed(base, draft, "links")) put("links", draft.links.map((link) => ({ kind: link.kind, url: link.url.trim() })));
  if (changed(base, draft, "tags")) put("tags", [...draft.tags]);
  if (changed(base, draft, "languages")) put("languages", [...draft.languages]);
  if (changed(base, draft, "region")) put("region", draft.region);
  if (changed(base, draft, "files")) {
    put(
      "recommendations",
      draft.files.map((file) => ({ jkhubId: jkhubId(file.link) ?? 0, title: file.title.trim() })),
    );
  }
  if (changed(base, draft, "bundleId")) put("bundleId", draft.bundleId);
  return any ? patch : null;
}

/** The body of `PUT communities/{id}/images`, or `null` when neither picture changed. */
export function imagesPatch(base: ManageDraft, draft: ManageDraft): { logo?: string | null; banner?: string | null } | null {
  const body: { logo?: string | null; banner?: string | null } = {};
  if (changed(base, draft, "logo")) body.logo = draft.logo;
  if (changed(base, draft, "banner")) body.banner = draft.banner;
  return Object.keys(body).length > 0 ? body : null;
}

/**
 * The form after the page under it moved from `previous` to `next`: what the
 * organizer changed stays, every other field follows the page. A field whose
 * value did not move keeps the form's rows, so a field being typed into is
 * not drawn again under the caret.
 */
export function rebase(previous: ManageDraft, draft: ManageDraft, next: ManageDraft): ManageDraft {
  const result: ManageDraft = { ...next };
  const keep = <F extends DraftField>(field: F) => {
    (result as unknown as Record<F, unknown>)[field] = draft[field];
  };
  for (const field of [...PAGE_FIELDS, ...IMAGE_FIELDS]) {
    if (changed(previous, draft, field) || !changed(previous, next, field)) keep(field);
  }
  if (changed(previous, draft, "bundleId")) {
    // The page names a saved bundle better than the picker did.
    result.bundleName = draft.bundleId === next.bundleId ? (next.bundleName ?? draft.bundleName) : draft.bundleName;
  }
  const labels: Record<string, string> = {};
  for (const [serverId, label] of Object.entries(next.labels)) {
    const typed = draft.labels[serverId];
    const before = previous.labels[serverId];
    labels[serverId] = typed !== undefined && before !== undefined && typed.trim() !== before.trim() ? typed : label;
  }
  result.labels = labels;
  return result;
}

/** The form of the screen: the page it was read from, the edits and their revision. */
export interface FormState {
  base: ManageDraft;
  draft: ManageDraft;
  /** The revision the edits were made on: what **Save changes** sends. */
  revision: number;
}

export type FormAction =
  /** The organizer changed fields. */
  | { type: "edit"; patch: Partial<ManageDraft> }
  /** **Discard**: the form says what the page says. */
  | { type: "discard" }
  /** The page was read again: every edit goes. */
  | { type: "reset"; community: Community }
  /** A write of this screen answered with the page after it. */
  | { type: "applied"; community: Community };

/** The form of a page that was just read. */
export function formOf(community: Community): FormState {
  const base = draftOf(community);
  return { base, draft: base, revision: community.revision };
}

export function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case "edit":
      return { ...state, draft: { ...state.draft, ...action.patch } };
    case "discard":
      return { ...state, draft: state.base };
    case "reset":
      return formOf(action.community);
    case "applied": {
      if (!isDirty(state.base, state.draft)) return formOf(action.community);
      const next = draftOf(action.community);
      const draft = rebase(state.base, state.draft, next);
      // One write of this screen moves the page by one. More means somebody
      // else wrote meanwhile, and the edits stay on the revision they were
      // made on, for the service to answer with a conflict. A form with
      // nothing left to save is the page itself and takes its revision.
      const own = action.community.revision === state.revision + 1;
      return {
        base: next,
        draft,
        revision: own || !isDirty(next, draft) ? action.community.revision : state.revision,
      };
    }
  }
}
