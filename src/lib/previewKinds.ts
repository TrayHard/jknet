/**
 * --- slice: pk3 contents ---
 * The taxonomy of a preview session: which kinds the list groups, in what
 * order, how each is shown, and what a caption may add. One table for the
 * preview dialog and the Base game tab, so a group is spelled one way.
 */

import type { FilePreviewEntry, FilePreviewKind, PreviewMode } from "./ipc";

/**
 * The groups of the object list, in the order of the pk3 reference: the
 * pictures first, then the objects with a scene or a player, then the text.
 */
export const PREVIEW_GROUP_KINDS: readonly FilePreviewKind[] = [
  "map", "levelshot", "splash", "menuImage", "hudImage", "texture", "icon", "image", "font",
  "skin", "hilt", "weapon", "npc", "vehicle", "music", "sound",
  "strings", "shader", "effect", "menu", "config", "data", "script", "video", "other",
];

/**
 * --- slice: preview modes ---
 * The groups of the **Simple** mode: what a player meets in the game — the
 * maps and their loading pictures, the splash, the menu and HUD pictures,
 * the objects with a scene or a player. The files behind them — textures,
 * fonts, strings, shaders, menus, configs — wait in **Advanced**.
 */
const SIMPLE_KINDS: ReadonlySet<FilePreviewKind> = new Set<FilePreviewKind>([
  "map", "levelshot", "splash", "menuImage", "hudImage",
  "skin", "hilt", "weapon", "npc", "vehicle", "music", "sound",
]);

/** The groups a mode lists, in group order. */
export function kindsOfMode(mode: PreviewMode): readonly FilePreviewKind[] {
  return mode === "simple" ? PREVIEW_GROUP_KINDS.filter(kind => SIMPLE_KINDS.has(kind)) : PREVIEW_GROUP_KINDS;
}

/**
 * The groups a session opens on, most wanted first: a player downloads a
 * file for its hilt or its skin, and the level shot that sorts first is not
 * what they came for. A session with none of these opens on its first
 * object in group order.
 */
const FIRST_PICK_ORDER: readonly FilePreviewKind[] = ["hilt", "skin", "map", "weapon", "npc", "vehicle", "levelshot"];

/** The object a dialog shows first, out of entries already in group order. */
export function firstPick(entries: readonly FilePreviewEntry[]): FilePreviewEntry | undefined {
  for (const kind of FIRST_PICK_ORDER) {
    const found = entries.find(entry => entry.kind === kind);
    if (found) return found;
  }
  return entries[0];
}

/** The kinds shown as a grid of thumbnails. */
const GALLERY_KINDS: ReadonlySet<FilePreviewKind> = new Set<FilePreviewKind>([
  "levelshot", "splash", "menuImage", "hudImage", "texture", "icon", "image",
]);

/** The kinds shown as text with line numbers. */
const TEXT_KINDS: ReadonlySet<FilePreviewKind> = new Set<FilePreviewKind>([
  "shader", "effect", "menu", "config", "data", "script",
]);

export function isGalleryKind(kind: FilePreviewKind): boolean {
  return GALLERY_KINDS.has(kind);
}

/**
 * Whether an entry opens as text: one of the text kinds, or any file the
 * core says it can read as text — a `readme.txt` among the other files.
 */
export function isTextEntry(entry: FilePreviewEntry): boolean {
  return TEXT_KINDS.has(entry.kind) || (entry.kind === "other" && entry.text != null);
}

/**
 * The subheading an entry sits under inside its group: the language of a
 * string package, the subfolder of a picture, nothing for the rest.
 */
export function subgroupOf(entry: FilePreviewEntry): string {
  if (entry.kind === "strings") return entry.strings?.language ?? "";
  return entry.group ?? "";
}

/**
 * --- slice: preview modes ---
 * The key a subgroup is collapsed under, `texture/yavin`: one set of keys
 * for the groups (the kind alone) and their subgroups, shared by the list
 * and the grid of pictures, so a folder folded in one is folded in the other.
 */
export function subgroupKey(entry: FilePreviewEntry): string {
  return `${entry.kind}/${subgroupOf(entry)}`;
}

/** The last segment of a path inside the archive. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The name without its extension, for a caption. */
export function stem(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

export function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

/** `mp/ffa3` out of `maps/mp/ffa3.bsp`, `MAPS\MP\FFA3.BSP` or `mp/ffa3`. */
export function mapKey(name: string): string {
  return name.toLowerCase().replace(/\\/g, "/").replace(/^maps\//, "").replace(/\.bsp$/, "");
}

/** Whether the map a level shot stands for is itself one of the session's objects. */
export function levelshotHasMap(entry: FilePreviewEntry, entries: readonly FilePreviewEntry[]): boolean {
  const wanted = mapKey(entry.map ?? stem(entry.name));
  const short = baseName(wanted);
  return entries.some(other => other.kind === "map" && (mapKey(other.name) === wanted || baseName(mapKey(other.name)) === short));
}

/**
 * What a caption adds beside the size of a picture, as codes the dialog
 * translates. Every rule is one of the pk3 reference: the two splash
 * pictures, the title crawl per language, the console font grid, and the
 * texture whose sides are not powers of two, which the vanilla renderer
 * refuses.
 */
export type ImageNote =
  | { code: "splashStretched" }
  | { code: "splashWide" }
  | { code: "titles"; language: string }
  | { code: "consoleFont" }
  | { code: "notPowerOfTwo" };

export function imageNotes(entry: FilePreviewEntry): ImageNote[] {
  const notes: ImageNote[] = [];
  const name = entry.name.toLowerCase().replace(/\\/g, "/");
  const file = stem(name);
  if (entry.kind === "splash") {
    if (file === "splash") notes.push({ code: "splashStretched" });
    else if (file === "splash_16_9") notes.push({ code: "splashWide" });
    else if (/^tc_/.test(file) && name.includes("menu/video/")) notes.push({ code: "titles", language: file.slice(3) });
  }
  if (file === "charsgrid_med" && name.startsWith("gfx/2d/")) notes.push({ code: "consoleFont" });
  const image = entry.image;
  if (image && image.width > 0 && image.height > 0 && !(isPowerOfTwo(image.width) && isPowerOfTwo(image.height))) {
    notes.push({ code: "notPowerOfTwo" });
  }
  return notes;
}

/**
 * The stock languages of the game as short codes for a badge: `strings:russian`
 * reads **RU strings**. A language outside the table keeps its first two
 * letters, uppercased.
 */
const LANGUAGE_CODES: Record<string, string> = {
  english: "EN", french: "FR", german: "DE", spanish: "ES", italian: "IT", portuguese: "PT",
  russian: "RU", polish: "PL", ukrainian: "UK", hungarian: "HU", czech: "CS", japanese: "JA",
  korean: "KO", chinese: "ZH", thai: "TH",
};

export function languageCode(language: string): string {
  const key = language.trim().toLowerCase();
  return LANGUAGE_CODES[key] ?? key.slice(0, 2).toUpperCase();
}

/**
 * The feature codes of the core with a fixed label, `library:features.<code>`:
 * the files of the taxonomy, then the objects the preview assembles.
 */
export const FEATURE_CODES = [
  "levelshots", "splash", "menu", "hud", "textures", "fonts", "shaders", "effects", "scripts", "videos", "configs", "modules",
  "characters", "hilts", "weapons", "npcs", "vehicles", "maps", "music", "sounds",
] as const;
export type FeatureCode = (typeof FEATURE_CODES)[number];

/** A feature of an archive as the badge prints it: a fixed label, or the strings of one language. */
export type FeatureBadgeSpec =
  | { code: FeatureCode }
  | { code: "strings"; language: string }
  | { code: "unknown"; raw: string };

export function featureBadge(feature: string): FeatureBadgeSpec {
  if (feature.startsWith("strings:")) return { code: "strings", language: feature.slice("strings:".length) };
  if ((FEATURE_CODES as readonly string[]).includes(feature)) return { code: feature as FeatureCode };
  return { code: "unknown", raw: feature };
}
