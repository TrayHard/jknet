/**
 * The seven categories the core sorts pk3 files into.
 *
 * One table drives the filter column, the card badge and the thumbnail icon,
 * so a category cannot be spelled one way in the sidebar and another on a
 * card. The ids mirror `LibraryCategory` in `src-tauri/src/library.rs`.
 */

import {
  Boxes,
  LayoutDashboard,
  Map,
  Package,
  Swords,
  User,
  Volume2,
  type LucideIcon,
} from "lucide-react";

import type { BadgeTone } from "../ui";
import type { LibraryCategory } from "../../lib/ipc";

export interface CategoryInfo {
  id: LibraryCategory;
  /** Plural label, as in the design's category column. */
  label: string;
  icon: LucideIcon;
  tone: BadgeTone;
}

export const CATEGORIES: CategoryInfo[] = [
  { id: "skin", label: "Skins", icon: User, tone: "accent" },
  { id: "hilt", label: "Hilts", icon: Swords, tone: "purple" },
  { id: "map", label: "Maps", icon: Map, tone: "success" },
  { id: "mod", label: "Mods", icon: Package, tone: "warm" },
  { id: "hud", label: "HUD & UI", icon: LayoutDashboard, tone: "neutral" },
  { id: "sound", label: "Sounds", icon: Volume2, tone: "neutral" },
  { id: "other", label: "Other", icon: Boxes, tone: "neutral" },
];

const FALLBACK: CategoryInfo = CATEGORIES[CATEGORIES.length - 1];

/** Never throws: a category the core adds later shows up as Other. */
export function categoryInfo(category: LibraryCategory): CategoryInfo {
  return CATEGORIES.find((entry) => entry.id === category) ?? FALLBACK;
}

/** Singular label for one card, where the plural reads wrong. */
export function categoryLabel(category: LibraryCategory): string {
  switch (category) {
    case "skin":
      return "Skin";
    case "hilt":
      return "Hilt";
    case "map":
      return "Map";
    case "mod":
      return "Mod";
    case "hud":
      return "HUD";
    case "sound":
      return "Sound";
    default:
      return "Other";
  }
}
