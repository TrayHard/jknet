import type {
  BundleCard,
  BundleComponentSummary,
  BundleFile,
  BundleManifest,
  Draft,
  DraftComponent,
  DraftFile,
  DraftImage,
} from "../../../lib/ipc";
import { isJkhubLink } from "../bundleFiles";

/**
 * --- slice: bundles ---
 *
 * What the editor derives from a draft without asking the core: the manifest
 * the draft would publish as, for the **Preview** section, and the limits of
 * the fields, for the **Overview** section.
 *
 * The rules of the manifest are the ones `publish.rs` applies, written a
 * second time here so the author sees the same record a player will. The
 * core stays the judge: a draft the two disagree on is a bug to fix there.
 */

/** The limits of the bundle and version fields, as the service checks them. */
export const LIMITS = {
  nameMin: 2,
  name: 64,
  summary: 200,
  /** Bytes of Markdown, the way the service measures it: 32 KiB. */
  description: 32 * 1024,
  tags: 10,
  label: 32,
  changelog: 4000,
  componentLabel: 40,
  launchArgs: 2000,
} as const;

export const TAG = /^[a-z0-9-]{1,24}$/;
export const HTTPS = /^https:\/\/\S+$/i;
export const DISCORD = /^https:\/\/(?:www\.)?(?:discord\.gg|discord\.com)\/\S+$/i;

/** Splits a tag field into tags: trimmed, lowercased, empties dropped. */
export function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag !== "");
}

/** A draft file as the manifest would carry it: the origin turned into a source. */
export function manifestFile(file: DraftFile): BundleFile {
  const origin = file.origin;
  const entry: BundleFile = {
    root: file.root,
    path: file.path,
    size: file.size,
    sha256: file.sha256,
    kind: file.kind,
    source: { kind: "blob" },
    library: file.library ?? null,
    listing: file.listing ?? null,
  };
  if (isJkhubLink(origin, file.sha256)) {
    if (origin.kind === "jkhub") {
      entry.source = {
        kind: "jkhub",
        fileId: origin.fileId,
        version: origin.version ?? null,
        title: origin.title ?? null,
        url: origin.url ?? null,
      };
    } else if (origin.kind === "client" && origin.provenance) {
      entry.source = {
        kind: "jkhub",
        fileId: origin.provenance.fileId,
        version: origin.provenance.version,
        title: origin.provenance.title,
        url: origin.provenance.url,
      };
    }
  } else if (origin.kind === "jkhub") {
    entry.origin = { kind: "jkhub", fileId: origin.fileId, sha256: origin.sha256, modified: true };
  }
  if (origin.kind === "release") {
    // The size of the release file is not in the draft; the hash is what the
    // record prints.
    entry.replaces = { sha256: origin.sha256, size: 0 };
  }
  return entry;
}

/** The manifest a draft would publish as. */
export function draftManifest(draft: Draft): BundleManifest {
  return {
    schema: 2,
    game: draft.game,
    components: draft.components.map((component) => ({
      id: component.id,
      label: component.label,
      engine: { engineId: component.engineId, releaseTag: component.releaseTag },
      modes: component.modes,
      fsGame: component.fsGame,
      launchArgs: component.launchArgs,
      overlay: {
        files: component.overlay.files.map(manifestFile),
        remove: component.overlay.remove,
      },
      files: component.files.map(manifestFile),
      configs: component.configs.map(({ name, text, priority }) => ({ name, text, priority })),
    })),
    shared: {
      files: draft.shared.files.map(manifestFile),
      configs: draft.shared.configs.map(({ name, text, priority }) => ({ name, text, priority })),
    },
  };
}

/** The summary of one draft component, as the service would compute it for the card. */
export function componentSummary(component: DraftComponent): BundleComponentSummary {
  const replaced = component.overlay.files.filter((file) => file.origin.kind === "release").length;
  return {
    id: component.id,
    label: component.label,
    engineId: component.engineId,
    releaseTag: component.releaseTag,
    modes: component.modes,
    replaced,
    added: component.overlay.files.length - replaced,
    removed: component.overlay.remove.length,
    fileCount: component.overlay.files.length + component.files.length,
  };
}

/**
 * The hashes a description refers to as `blob:<sha256>`, lowercased, each
 * once. The scan is by the scheme and the 64 hex characters after it rather
 * than by the Markdown around them, the way the core and the service read a
 * description: a reference outside a picture tag is still a file they look
 * for.
 */
export function descriptionImageRefs(description: string): Set<string> {
  const refs = new Set<string>();
  for (const match of description.matchAll(/blob:([0-9a-f]+)/gi)) {
    if (match[1].length === 64) refs.add(match[1].toLowerCase());
  }
  return refs;
}

/** The pictures of a draft its description does not refer to: the ones `unusedImages` counts. */
export function unusedImages(draft: Draft): DraftImage[] {
  const refs = descriptionImageRefs(draft.description);
  return (draft.images ?? []).filter((image) => !refs.has(image.sha256.toLowerCase()));
}

/** Every file of a draft, overlay and `home\` of every part alike. */
export function draftFiles(draft: Draft): DraftFile[] {
  return [
    ...draft.components.flatMap((component) => [...component.overlay.files, ...component.files]),
    ...draft.shared.files,
  ];
}

/**
 * The card the catalogue would show for a draft.
 *
 * The counters are what the service would compute: bytes of the files that
 * go to the store, the number of files, whether an executable is among them.
 * Likes and installs start at zero, and the owner is whoever publishes.
 */
export function draftCard(draft: Draft, owner: BundleCard["owner"]): BundleCard {
  const files = draftFiles(draft);
  const blobBytes = files
    .filter((file) => !isJkhubLink(file.origin, file.sha256))
    .reduce((sum, file) => sum + file.size, 0);
  return {
    id: draft.bundleId ?? draft.id,
    slug: draft.bundleSlug ?? "",
    name: draft.name,
    summary: draft.summary,
    language: draft.language,
    // With the descriptions: the card of the catalogue list does without
    // them, and the preview of the record reads them off the same card.
    translations: draft.translations,
    game: draft.game,
    engineId: draft.components[0]?.engineId ?? "",
    releaseTag: draft.components[0]?.releaseTag ?? null,
    components: draft.components.map(componentSummary),
    owner,
    tags: draft.tags,
    blobBytes,
    fileCount: files.length,
    hasExecutables: files.some((file) => file.kind === "exe" || file.kind === "dll"),
    featured: false,
    likes: 0,
    installs: 0,
    latestVersionId: null,
    latestLabel: draft.versionLabel,
    publishedAt: null,
    updatedAt: draft.updatedAt,
  };
}

/** The folders a `home\` file of a scope may go into: `base` and the mod folders of the components. */
export function destinationFolders(draft: Draft, scope: string): string[] {
  const folders = ["base"];
  const components =
    scope === "shared"
      ? draft.components
      : draft.components.filter((component) => component.id === scope);
  for (const component of components) {
    if (component.fsGame && !folders.includes(component.fsGame)) folders.push(component.fsGame);
  }
  return folders;
}
