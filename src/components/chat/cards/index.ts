import type { ComponentType } from "react";

import type { ChatCard, ChatMessage } from "../../../lib/ipc";

/**
 * --- slice: chat ---
 *
 * The card kinds the thread knows how to draw, by the `type` of the card.
 *
 * The registry is filled by the slice of the cards: `server`, `hostInvite`,
 * `bundle`, `jkhubMod`, `map`, `profile`, `bind`, `config`. A card whose kind
 * is not registered draws its `fallbackText` in `CardFallback`, which is also
 * what an older launcher shows for a kind added after it.
 */
export interface CardProps {
  card: ChatCard;
  message: ChatMessage;
}

export const CARD_KINDS: Partial<Record<string, ComponentType<CardProps>>> = {};

/** The component of a card kind, or `undefined` for one this launcher does not draw. */
export function cardComponent(type: string): ComponentType<CardProps> | undefined {
  return Object.prototype.hasOwnProperty.call(CARD_KINDS, type) ? CARD_KINDS[type] : undefined;
}
