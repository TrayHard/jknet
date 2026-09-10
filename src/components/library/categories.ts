/**
 * The seven categories the core sorts pk3 files into.
 *
 * One table drives the filter column, the card badge and the thumbnail icon,
 * so a category cannot be spelled one way in the sidebar and another on a
 * card. The ids mirror `LibraryCategory` in `src-tauri/src/library.rs`.
 *
 * --- slice: i18n ---
 * The names are not here. `library.categories.<id>` is the plural for the rail
 * and `library.categoryOne.<id>` the singular for a card badge, and both are
 * looked up by the id below — so a category is still spelled one way, in the
 * catalogs instead of in this file.
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
  icon: LucideIcon;
  tone: BadgeTone;
}

export const CATEGORIES: CategoryInfo[] = [
  { id: "skin", icon: User, tone: "accent" },
  { id: "hilt", icon: Swords, tone: "purple" },
  { id: "map", icon: Map, tone: "success" },
  { id: "mod", icon: Package, tone: "warm" },
  { id: "hud", icon: LayoutDashboard, tone: "neutral" },
  { id: "sound", icon: Volume2, tone: "neutral" },
  { id: "other", icon: Boxes, tone: "neutral" },
];

const FALLBACK: CategoryInfo = CATEGORIES[CATEGORIES.length - 1];

/** Never throws: a category the core adds later shows up as Other. */
export function categoryInfo(category: LibraryCategory): CategoryInfo {
  return CATEGORIES.find((entry) => entry.id === category) ?? FALLBACK;
}
