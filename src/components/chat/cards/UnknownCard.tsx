import { CardFallback } from "./CardFallback";
import type { CardProps } from "./index";

/**
 * --- slice: chat cards ---
 *
 * A card of a type this launcher does not know: a newer JKNet added it. The
 * text its sender's launcher wrote for exactly this case, and a line saying
 * that an update would show the card itself.
 */
export function UnknownCard(props: CardProps) {
  return <CardFallback {...props} known={false} />;
}
