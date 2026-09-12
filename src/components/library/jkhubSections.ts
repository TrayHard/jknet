import { useTranslation } from "react-i18next";

import type { JkhubCategory } from "../../lib/ipc";

/**
 * The eight sections of the JKHub catalogue, in the order the core answers.
 *
 * The list is here only so a key can be typed: the site ids behind each of
 * them live in one place, `src-tauri/src/jkhub/sections.rs`, and the tree
 * arrives already built out of them. A key added there and missing here shows
 * the site's own name until it is added, and `npm run i18n:check` catches the
 * missing string.
 */
export const SECTION_KEYS = [
  "maps",
  "skins",
  "sabers",
  "guns",
  "npcs",
  "vehicles",
  "singlePlayer",
  "audio",
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

function isSectionKey(value: string | undefined): value is SectionKey {
  return value != null && (SECTION_KEYS as readonly string[]).includes(value);
}

/**
 * Names a node of the tree the way the player reads it.
 *
 * A section is named by the launcher, in the player's language: jkhub.org
 * calls the same shelf «Lightsabers & Melee», and one of them is two
 * categories of the site at once. A node that carries no section key — a raw
 * site category, which only an older core answers with — keeps the site's
 * name, so nothing renders blank while a build is mixed.
 *
 * ```ts
 * name({ section: "sabers", name: "Lightsabers & Melee", ... }) // "Sabers"
 * name({ name: "Prefabs", ... })                                // "Prefabs"
 * ```
 */
export function useSectionName(): (category: JkhubCategory) => string {
  const { t } = useTranslation("jkhub");
  return (category) =>
    isSectionKey(category.section) ? t(`sections.${category.section}`) : category.name;
}
