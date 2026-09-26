import type { ComponentType } from "react";

import { readCard, type CardType, type FieldsOf } from "../../../lib/chat/cardDrafts";
import { CardFallback } from "./CardFallback";
import type { CardProps } from "./index";

/** What a card component of one type is given: the card, its message and its fields. */
export type CardViewProps<T extends CardType> = CardProps & { fields: FieldsOf<T> };

/**
 * --- slice: chat cards ---
 *
 * The component of one card type as the registry holds it: the card is read
 * first, and one that lacks a field its view needs is drawn as its
 * `fallbackText`, the way a launcher that does not know the type draws it.
 */
export function withFields<T extends CardType>(
  type: T,
  View: ComponentType<CardViewProps<T>>,
): ComponentType<CardProps> {
  function Card(props: CardProps) {
    const parsed = readCard(props.card);
    if (parsed === null || parsed.type !== type) return <CardFallback {...props} known />;
    return <View {...props} fields={parsed.fields as FieldsOf<T>} />;
  }
  Card.displayName = `ChatCard(${type})`;
  return Card;
}
