import type { JkhubCardData, JkhubListing } from "./ipc";

export interface JkhubCompleteListing {
  pages: number;
  cards: JkhubCardData[];
}

/** Combines every page of one JKHub category without duplicating file cards. */
export function mergeJkhubCategoryPages(listings: JkhubListing[]): JkhubCompleteListing {
  const cards = new Map<number, JkhubCardData>();
  for (const listing of listings) {
    for (const card of listing.cards) cards.set(card.id, card);
  }
  return {
    pages: Math.max(0, ...listings.map((listing) => listing.pages)),
    cards: [...cards.values()],
  };
}

/** Searches the complete server-side category while preserving JKHub order. */
export function filterServerModCards(cards: JkhubCardData[], query: string): JkhubCardData[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return cards;
  return cards.filter((card) =>
    [card.title, card.slug, card.description, ...card.tags]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );
}
