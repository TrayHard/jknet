import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { CardProps } from "./index";

/**
 * --- slice: chat ---
 *
 * A card this launcher does not draw: the text its sender wrote for exactly
 * this case, in a quiet box. A kind the launcher does not know at all — a
 * newer version added it — says that an update would show it.
 */
export function CardFallback({ card, known }: CardProps & { known: boolean }) {
  const { t } = useTranslation("chat");
  return (
    <div className="flex w-[300px] max-w-full flex-col gap-4 rounded-md border border-line bg-input px-10 py-8">
      <span className="whitespace-pre-wrap text-body-sm text-fg [overflow-wrap:anywhere] [unicode-bidi:isolate]">
        {card.fallbackText || t("cards.empty")}
      </span>
      {known ? null : (
        <span className="flex items-center gap-4 text-body-sm text-fg-muted">
          <Info size={12} className="shrink-0" />
          {t("cards.unknown")}
        </span>
      )}
    </div>
  );
}

/**
 * Card kinds of this release. Each has its own component; one of them that
 * lacks a field its component needs still says nothing about updating.
 */
export const KNOWN_CARD_KINDS = new Set([
  "server",
  "hostInvite",
  "bundle",
  "jkhubMod",
  "map",
  "profile",
  "bind",
  "config",
]);
